/**
 * dsh-simple-remote — serve the DeepSeek Harness Web GUI to a Tailscale tailnet.
 *
 * The shipped Web composition binds `@deepseek-ai/dsh-host-webserver` to a
 * loopback-only host (`host` accepts exactly `127.0.0.1` or `0.0.0.0`), and its
 * `/api` browser-trust fence admits loopback or declared authorities. Neither
 * expresses "reachable by my own tailnet and by nothing else", so this plugin
 * adds that missing posture without weakening either one:
 *
 * - A second listener, bound to the machine's Tailscale address only, reverse
 *   proxies every request to the loopback GUI. The LAN, WSL and virtual-switch
 *   addresses never listen, so nothing off the tailnet can even open a socket.
 * - Forwarded requests keep their path, body, cookies and streaming semantics.
 *   The proxy rewrites the upstream authority to the loopback GUI, which keeps
 *   the shipped Host/Origin fence exactly as strict as before (no authority is
 *   granted), and rewrites `Origin` only when it was same-origin with the
 *   request it received — a cross-site request keeps its foreign Origin and is
 *   refused by the fence.
 * - `autoToken` (on by default) completes the launch-token exchange for a
 *   browser navigation that has no session cookie yet, so a phone on the
 *   tailnet can open the plain `http://<tailnet-address>:<port>/` address.
 *   With `autoToken: false` the printed `?token=…` URL is required, and the
 *   tailnet behaves exactly like the loopback address does.
 *
 * @module dsh-simple-remote
 */

import { createHash } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { networkInterfaces } from 'node:os'

/** Stable Cordis plugin name. */
export const name = 'simple-remote'

/** The listener needs the composed Web server (its port and its loopback bind). */
export const inject = ['webServer']

/** The loopback literal the shipped Web composition binds. */
const LOOPBACK = '127.0.0.1'
/** Tailscale's CGNAT range, 100.64.0.0/10: the addresses the tailnet hands out. */
const TAILNET_V4 = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./
/** Interface-name hint for tailnets whose addresses are not in the CGNAT range. */
const TAILNET_INTERFACE = /^tailscale/i
/** Browser-session cookie prefix owned by `@deepseek-ai/dsh-client-connection`. */
const COOKIE_PREFIX = 'dsh-auth-'
/** Request headers that describe one hop and must not be forwarded verbatim. */
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'expect']

/**
 * Resolve the row config, applying defaults without a schema dependency.
 * @param config - the raw row config from the bundle patch.
 * @returns normalized options.
 */
function readOptions(config) {
	const source = config ?? {}
	return {
		enabled: source.enabled !== false,
		/** Explicit tailnet address; empty means detect from the interfaces. */
		address: typeof source.address === 'string' ? source.address.trim() : '',
		/** Tailnet port; 0 (the default) mirrors the loopback GUI's port. */
		port: Number.isInteger(source.port) && source.port >= 0 && source.port <= 65535 ? source.port : 0,
		/** Complete the launch-token exchange for a cookieless browser navigation. */
		autoToken: source.autoToken !== false,
		/** Mirror the plugin's URL lines to stdout. */
		log: source.log !== false,
	}
}

/**
 * Tailnet IPv4 addresses of this machine, in interface order.
 * @param explicit - a configured address, which replaces detection entirely.
 * @returns the addresses a listener should bind, deduplicated.
 */
function detectAddresses(explicit) {
	if (explicit !== '') return [explicit]
	const found = []
	for (const [iface, list] of Object.entries(networkInterfaces())) {
		for (const info of list ?? []) {
			if (info.family !== 'IPv4' || info.internal) continue
			if (TAILNET_V4.test(info.address) || TAILNET_INTERFACE.test(iface)) found.push(info.address)
		}
	}
	return [...new Set(found)]
}

/** Bracket an IPv6 literal so it composes into a URL authority. */
function formatHost(address) {
	return address.includes(':') ? `[${address}]` : address
}

/** The `dsh-auth-…` cookie name this deployment's loopback authority mints. */
function sessionCookieName(upstreamPort) {
	const digest = createHash('sha256').update(`${LOOPBACK}:${upstreamPort}`).digest('base64url')
	return `${COOKIE_PREFIX}${digest}`
}

/** Whether the request already carries a browser-session cookie for this GUI. */
function hasSessionCookie(request, upstreamPort) {
	const cookie = request.headers.cookie
	return typeof cookie === 'string' && cookie.includes(`${sessionCookieName(upstreamPort)}=`)
}

/** Whether the request is a browser navigation, the only flow `autoToken` helps. */
function isNavigation(request) {
	if (request.method !== 'GET') return false
	const mode = request.headers['sec-fetch-mode']
	if (typeof mode === 'string') return mode === 'navigate'
	const accept = request.headers.accept
	return typeof accept === 'string' && accept.includes('text/html')
}

/** The process launch token, read from the live Connection service. */
function launchToken(ctx, upstreamPort) {
	const connection = ctx.get('connection')
	if (connection === undefined) return undefined
	try {
		const url = new URL(connection.authenticatedUrl(`http://${LOOPBACK}:${upstreamPort}`))
		return url.searchParams.get('token') ?? undefined
	} catch {
		return undefined
	}
}

/** Add the launch token to a base URL. */
function withToken(base, token) {
	return token === undefined ? base : `${base}?token=${encodeURIComponent(token)}`
}

/**
 * Rewrite the forwarded authority to the loopback GUI.
 *
 * `Origin` is rewritten only when it named the authority this request arrived
 * on (a same-origin browser request); anything else keeps its value so the
 * shipped fence can reject it.
 * @param headers - the mutable headers about to be forwarded.
 * @param request - the request as received on the tailnet listener.
 * @param upstreamPort - the loopback GUI port.
 */
function rewriteAuthority(headers, request, upstreamPort) {
	const received = request.headers.host
	const origin = headers.origin
	if (typeof origin === 'string') {
		try {
			if (new URL(origin).host === received) headers.origin = `http://${LOOPBACK}:${upstreamPort}`
		} catch {
			/* An unparsable Origin keeps its value and is refused downstream. */
		}
	}
	headers.host = `${LOOPBACK}:${upstreamPort}`
}

/** Forward one HTTP request to the loopback GUI. */
function forwardRequest(ctx, state, request, response) {
	const headers = { ...request.headers }
	rewriteAuthority(headers, request, state.upstreamPort)
	for (const header of HOP_BY_HOP) delete headers[header]

	const upstream = httpRequest({
		host: LOOPBACK,
		port: state.upstreamPort,
		method: request.method,
		path: request.url,
		headers,
	}, (upstreamResponse) => {
		upstreamResponse.on('error', () => response.destroy())
		response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
		upstreamResponse.pipe(response)
	})
	upstream.on('error', (error) => {
		ctx.logger.warn(`simple-remote: tailnet proxy could not reach ${LOOPBACK}:${state.upstreamPort} (${error.code ?? error.message})`)
		if (response.headersSent) {
			response.destroy()
			return
		}
		response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
		response.end('simple-remote: the Harness Web server on the loopback address is unreachable.\n')
	})
	request.on('error', () => upstream.destroy())
	response.on('error', () => upstream.destroy())
	response.on('close', () => upstream.destroy())
	request.pipe(upstream)
}

/** Forward one WebSocket handshake and then the raw socket both ways. */
function forwardUpgrade(ctx, state, request, socket, head) {
	const headers = { ...request.headers }
	rewriteAuthority(headers, request, state.upstreamPort)
	delete headers['proxy-connection']

	const upstream = netConnect(state.upstreamPort, LOOPBACK, () => {
		const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/1.1`]
		for (const [key, value] of Object.entries(headers)) {
			if (value === undefined) continue
			if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`)
			else lines.push(`${key}: ${value}`)
		}
		upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
		if (head !== undefined && head.length > 0) upstream.write(head)
		upstream.pipe(socket)
		socket.pipe(upstream)
	})
	const fail = (error) => {
		ctx.logger.warn(`simple-remote: tailnet upgrade proxy failed (${error.code ?? error.message})`)
		socket.destroy()
		upstream.destroy()
	}
	upstream.on('error', fail)
	socket.on('error', fail)
	socket.on('close', () => upstream.destroy())
	upstream.on('close', () => socket.destroy())
}

/** The value the browser page reads to render its remote-access row. */
function clientState(state) {
	const base = state.urls[0]
	return {
		enabled: true,
		autoToken: state.autoToken,
		urls: [...state.urls],
		loginUrl: base === undefined ? undefined : withToken(base, state.token),
	}
}

/** Print the remote-access lines once per fact, to the log and to stdout. */
function announceBase(ctx, state) {
	if (state.announcedBase || state.urls.length === 0) return
	state.announcedBase = true
	const line = `dsh web: tailnet ${state.urls[0]}${state.autoToken ? ' (Tailscale; auto-login)' : ''}`
	ctx.logger.info(line)
	if (state.log) console.log(line)
}

/** Print the tokenized remote URL once the launch token is known. */
function announceToken(ctx, state) {
	if (state.announcedToken || state.urls.length === 0 || state.token === undefined) return
	state.announcedToken = true
	const line = `dsh web: tailnet with token ${withToken(state.urls[0], state.token)}`
	ctx.logger.info(line)
	if (state.log) console.log(line)
}

/**
 * Mount the tailnet bridge: one listener per tailnet address, the launch-token
 * handshake for cookieless navigations, and the page state the Client half reads.
 * @param ctx - the plugin context carrying `webServer`.
 * @param config - the row config.
 */
export function apply(ctx, config) {
	const options = readOptions(config)
	if (!options.enabled) return

	const upstreamPort = ctx.webServer.port
	if (upstreamPort === undefined) {
		ctx.logger.warn('simple-remote: the Web server has no listening port yet; no tailnet listener started')
		return
	}

	const addresses = detectAddresses(options.address)
	if (addresses.length === 0) {
		ctx.logger.warn('simple-remote: no Tailscale address found on this machine; is Tailscale connected? no tailnet listener started')
		return
	}

	const state = {
		upstreamPort,
		autoToken: options.autoToken,
		log: options.log,
		token: undefined,
		urls: [],
		announcedBase: false,
		announcedToken: false,
	}
	const servers = []
	// Upgraded sockets outlive their request, so disposal has to end them too.
	const upgradedSockets = new Set()

	for (const address of addresses) {
		const server = createServer((request, response) => {
			// The first navigation of a device that holds no session cookie gets
			// the launch token, which mints the cookie for this authority.
			if (options.autoToken && isNavigation(request) && state.token !== undefined) {
				let direct
				try {
					direct = new URL(request.url ?? '/', 'http://dsh.invalid')
				} catch {
					direct = undefined
				}
				if (direct !== undefined && direct.pathname === '/' && !direct.searchParams.has('token') && !hasSessionCookie(request, upstreamPort)) {
					response.writeHead(302, {
						location: `/?token=${encodeURIComponent(state.token)}`,
						'cache-control': 'no-store',
						'referrer-policy': 'no-referrer',
					})
					response.end()
					return
				}
			}
			forwardRequest(ctx, state, request, response)
		})
		server.on('upgrade', (request, socket, head) => {
			upgradedSockets.add(socket)
			socket.once('close', () => upgradedSockets.delete(socket))
			forwardUpgrade(ctx, state, request, socket, head)
		})
		server.on('error', (error) => {
			ctx.logger.warn(`simple-remote: tailnet listener on ${address} failed (${error.code ?? error.message})`)
		})
		server.listen(options.port > 0 ? options.port : upstreamPort, address, () => {
			const assigned = server.address()
			const port = typeof assigned === 'object' && assigned !== null ? assigned.port : state.upstreamPort
			state.urls.push(`http://${formatHost(address)}:${port}/`)
			announceBase(ctx, state)
		})
		servers.push(server)
	}

	ctx.effect(() => () => {
		for (const socket of upgradedSockets) socket.destroy()
		upgradedSockets.clear()
		for (const server of servers) {
			// Idle keep-alive sockets would otherwise hold `close()` open forever.
			server.close()
			server.closeAllConnections?.()
		}
	}, 'simple-remote: tailnet listeners')

	ctx.on('webserver/index-inject', (table) => {
		table.push({ kind: 'global', name: '__DSH_SIMPLE_REMOTE__', value: clientState(state) })
	})

	// The launch token lives in the Connection service, which may activate
	// before or after this row; resolve it whenever it appears.
	ctx.inject(['connection'], (connectionCtx) => {
		state.token = launchToken(connectionCtx, upstreamPort)
		announceToken(connectionCtx, state)
		if (state.token === undefined) {
			ctx.logger.warn('simple-remote: Connection exposed no launch token; auto-login stays inactive')
		}
	})
}
