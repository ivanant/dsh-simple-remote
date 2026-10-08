/**
 * Standalone smoke test for dsh-simple-remote.
 *
 * It loads the real plugin modules outside the Harness (no Cordis), runs the
 * browser half's factory against a React stub, and drives the host half's
 * proxy end to end against a stub upstream that mimics the shipped Web
 * composition. Nothing here touches the running Harness.
 *
 * Run: node test/smoke.mjs
 */

import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TAILNET_V4 = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./
const passed = []

function ok(label) {
	passed.push(label)
	console.log(`  ok  ${label}`)
}

/** The machine's Tailscale address, or loopback when this host has none. */
function tailnetAddress() {
	for (const list of Object.values(networkInterfaces())) {
		for (const info of list ?? []) {
			if (info.family === 'IPv4' && !info.internal && TAILNET_V4.test(info.address)) return info.address
		}
	}
	return '127.0.0.1'
}

/** One free TCP port on the loopback interface. */
function freePort() {
	return new Promise((resolve, reject) => {
		const probe = createServer()
		probe.on('error', reject)
		probe.listen(0, '127.0.0.1', () => {
			const port = probe.address().port
			probe.close(() => resolve(port))
		})
	})
}

/** Send one request and collect status, headers and body. */
function call(port, { method = 'GET', path = '/', headers = {}, body, address = '127.0.0.1' }) {
	return new Promise((resolve, reject) => {
		const request = httpRequest({ host: address, port, method, path, headers, agent: false }, (response) => {
			let text = ''
			response.setEncoding('utf8')
			response.on('data', (chunk) => {
				text += chunk
			})
			response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }))
		})
		request.on('error', reject)
		if (body !== undefined) request.write(body)
		request.end()
	})
}

/** One raw HTTP upgrade round trip, returned as the raw response head. */
function upgrade(port, address, host, path) {
	return new Promise((resolve, reject) => {
		const socket = netConnect(port, address, () => {
			socket.write([
				`GET ${path} HTTP/1.1`,
				`Host: ${host}`,
				'Connection: Upgrade',
				'Upgrade: websocket',
				'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
				'Sec-WebSocket-Version: 13',
				'Origin: http://' + host,
				'', '',
			].join('\r\n'))
		})
		let head = ''
		socket.setTimeout(4000, () => {
			socket.destroy()
			reject(new Error('upgrade timed out'))
		})
		socket.on('data', (chunk) => {
			head += chunk.toString('utf8')
			if (head.includes('\r\n\r\n')) {
				socket.destroy()
				resolve(head)
			}
		})
		socket.on('error', reject)
	})
}

/** The browser half, run against a React stub. */
async function checkClient() {
	const source = await readFile(join(ROOT, 'client.js'), 'utf8')
	let entry
	const elements = []
	const React = {
		createElement: (type, props, ...children) => {
			elements.push({ type, props, children })
			return { type, props, children }
		},
		useState: (initial) => [initial, () => {}],
		useRef: (initial) => ({ current: initial }),
		useEffect: () => {},
	}
	const documentStub = {
		querySelector: () => null,
		createElement: () => ({ dataset: {}, style: {} }),
		head: { appendChild: () => {} },
		body: { appendChild: () => {}, removeChild: () => {} },
		execCommand: () => true,
	}
	const windowStub = { __ModuleLoader__: { load: (value) => { entry = value } } }
	const navigatorStub = {}
	// Evaluate the classic browser script in a scope that provides its globals.
	new Function('window', 'document', 'navigator', source)(windowStub, documentStub, navigatorStub)
	assert.equal(entry.id, 'dsh-simple-remote', 'client entry id')
	assert.equal(typeof entry.factory, 'function', 'client factory')
	const plugin = entry.factory((id) => {
		if (id === 'react') return React
		throw new Error(`unexpected client require: ${id}`)
	})
	ok('client bundle registers a factory and resolves only react')

	let registration
	let dictionary
	const ctx = {
		effect: (fn) => {
			fn()
		},
		locale: { register: (ns, dict) => { dictionary = { ns, dict } } },
		slots: {
			inject: (slot, callback) => { callback() },
			register: (options, Component) => { registration = { options, Component } },
		},
	}
	plugin.apply(ctx)
	assert.equal(registration.options.name, 'settings.general.item')
	assert.equal(registration.options.id, 'simple-remote')
	assert.equal(typeof registration.Component, 'function')
	assert.equal(registration.options.locale, dictionary.ns)
	assert.ok(dictionary.dict.zh.title && dictionary.dict.en.title, 'both dictionaries registered')
	ok('client plugin registers the General settings row and both dictionaries')

	globalThis.__DSH_SIMPLE_REMOTE__ = {
		enabled: true,
		autoToken: true,
		urls: ['http://100.64.1.2:3080/'],
		loginUrl: 'http://100.64.1.2:3080/?token=abc',
	}
	const autoRow = registration.Component({ t: (key) => key })
	assert.ok(autoRow !== null, 'autoToken row renders')
	globalThis.__DSH_SIMPLE_REMOTE__ = { enabled: false, autoToken: false, urls: [], loginUrl: undefined }
	assert.equal(registration.Component({ t: (key) => key }), null, 'disabled state renders nothing')
	globalThis.__DSH_SIMPLE_REMOTE__ = { enabled: true, autoToken: false, urls: ['http://100.64.1.2:3080/'], loginUrl: 'http://100.64.1.2:3080/?token=abc' }
	const tokenRow = registration.Component({ t: (key) => key })
	assert.ok(tokenRow !== null, 'token mode row renders')
	ok('component renders in auto, token and disabled states')

	// The copy path: the clipboard stub must receive the address the row shows.
	let copied
	navigatorStub.clipboard = { writeText: (value) => { copied = value; return Promise.resolve() } }
	const row = registration.Component({ t: (key) => key })
	const line = row.children[0].find((child) => child?.props?.className === 'dsr-line')
	const button = line.children[0].find((child) => child?.props?.className === 'dsr-button')
	button.props.onClick()
	await new Promise((resolve) => setImmediate(resolve))
	assert.equal(copied, 'http://100.64.1.2:3080/?token=abc', 'copy button copies the tokenized URL')
	ok('copy button hands the tokenized URL to the clipboard')
}

/** The host half, driven against a stub upstream. */
async function checkHost() {
	const plugin = await import(pathToFileURL(join(ROOT, 'index.js')).href)
	assert.equal(typeof plugin.apply, 'function')
	assert.ok(plugin.inject.includes('webServer'), 'declares the webServer injection')
	ok('host bundle loads and declares its injection')

	const address = tailnetAddress()
	const upstreamPort = await freePort()
	const listenPort = await freePort()
	const token = 'TESTTOKEN'
	// Sockets the stub's server tracks as connections; `close()` waits for them.
	const upgraded = new Set()
	// The session cookie name the shipped Connection mints for the loopback
	// authority the proxy forwards to.
	const cookieName = `dsh-auth-${createHash('sha256').update(`127.0.0.1:${upstreamPort}`).digest('base64url')}`
	const seen = []
	const upstream = createServer((request, response) => {
		seen.push({ method: request.method, url: request.url, host: request.headers.host, origin: request.headers.origin })
		if (request.url === '/?token=' + token) {
			response.writeHead(303, { location: './', 'set-cookie': `${cookieName}=v1.payload.signature; Path=/` })
			response.end()
			return
		}
		response.writeHead(200, { 'content-type': 'text/plain' })
		response.end(`${request.method} ${request.url}`)
	})
	upstream.on('upgrade', (request, socket) => {
		seen.push({ method: request.method, url: request.url, upgrade: true, host: request.headers.host, origin: request.headers.origin })
		upgraded.add(socket)
		socket.once('close', () => upgraded.delete(socket))
		socket.write([
			'HTTP/1.1 101 Switching Protocols',
			'Upgrade: websocket',
			'Connection: Upgrade',
			'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
			'', '',
		].join('\r\n'))
	})
	await new Promise((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve))

	const warnings = []
	let injectTable
	const disposers = []
	const ctx = {
		webServer: { port: upstreamPort },
		logger: { info: () => {}, warn: (message) => warnings.push(String(message)) },
		get: (name) => (name === 'connection' ? { authenticatedUrl: (base) => `${base}/?token=${token}` } : undefined),
		inject: (deps, callback) => { callback(ctx) },
		on: (name, callback) => { if (name === 'webserver/index-inject') injectTable = callback },
		effect: (fn) => { disposers.push(fn()) },
	}
	plugin.apply(ctx, { enabled: true, autoToken: true, address, port: listenPort, log: false })
	await new Promise((resolve) => setTimeout(resolve, 250))

	const host = `${address}:${listenPort}`
	const navigation = { host, 'sec-fetch-mode': 'navigate', accept: 'text/html' }

	const first = await call(listenPort, { path: '/', headers: navigation, address })
	assert.equal(first.status, 302, 'first navigation is redirected to the token URL')
	assert.equal(first.headers.location, `/?token=${token}`)
	ok('a cookieless navigation gets the token redirect (auto-login)')

	const exchange = await call(listenPort, { path: `/?token=${token}`, headers: navigation, address })
	assert.equal(exchange.status, 303, 'token exchange reaches the upstream')
	assert.ok(String(exchange.headers['set-cookie']).includes(cookieName), 'session cookie is passed back')
	assert.equal(seen.at(-1).host, `127.0.0.1:${upstreamPort}`, 'upstream sees the loopback authority')
	ok('the token exchange reaches the upstream and its cookie survives the proxy')

	const cookie = `${cookieName}=v1.payload.signature`
	const index = await call(listenPort, { path: '/', headers: { ...navigation, cookie }, address })
	assert.equal(index.status, 200)
	assert.equal(index.text, 'GET /')
	ok('a session cookie suppresses the redirect and reaches the index')

	const api = await call(listenPort, {
		method: 'POST',
		path: '/api/ping',
		headers: { host, cookie, origin: `http://${host}`, 'content-type': 'application/json' },
		body: '{}',
		address,
	})
	assert.equal(api.status, 200)
	assert.equal(seen.at(-1).origin, `http://127.0.0.1:${upstreamPort}`, 'same-origin Origin is rewritten with the authority')
	ok('same-origin /api traffic is rewritten so the shipped fence accepts it')

	await call(listenPort, {
		method: 'POST',
		path: '/api/ping',
		headers: { host, origin: 'https://evil.example', 'content-type': 'application/json' },
		body: '{}',
		address,
	})
	assert.equal(seen.at(-1).origin, 'https://evil.example', 'a foreign Origin is left for the fence to refuse')
	assert.equal(seen.at(-1).host, `127.0.0.1:${upstreamPort}`)
	ok('a cross-site Origin is forwarded unchanged')

	const head = await upgrade(listenPort, address, host, '/api/stream')
	assert.ok(head.startsWith('HTTP/1.1 101'), `upgrade is proxied (got ${head.split('\r\n')[0]})`)
	assert.equal(seen.at(-1).upgrade, true)
	assert.equal(seen.at(-1).origin, `http://127.0.0.1:${upstreamPort}`, 'upgrade authority is rewritten too')
	ok('WebSocket upgrades are proxied with the rewritten authority')

	const table = []
	injectTable(table)
	const state = table[0]?.value
	assert.equal(table[0]?.name, '__DSH_SIMPLE_REMOTE__')
	assert.deepEqual(state.urls, [`http://${address}:${listenPort}/`])
	assert.equal(state.loginUrl, `http://${address}:${listenPort}/?token=${token}`)
	ok('the page state carries the tailnet URL and its tokenized login URL')

	for (const dispose of disposers) await dispose()
	await new Promise((resolve) => setTimeout(resolve, 150))
	for (const socket of upgraded) socket.destroy()
	upgraded.clear()
	await new Promise((resolve) => upstream.close(resolve))
	const down = await call(listenPort, { path: '/', headers: navigation, address }).then(() => 'open', () => 'closed')
	assert.equal(down, 'closed', 'disposal closes the tailnet listener')
	ok('disposal closes the tailnet listener')
	assert.deepEqual(warnings, [])
}

console.log(`dsh-simple-remote smoke test (tailnet address: ${tailnetAddress()})`)
await checkClient()
await checkHost()
console.log(`\n${passed.length} checks passed`)
