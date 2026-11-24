/**
 * Browser half of dsh-simple-remote: the General-settings row that shows the
 * tailnet address of this harness and copies it.
 *
 * The host half injects `globalThis.__DSH_SIMPLE_REMOTE__` into the page
 * (`webserver/index-inject`), so the row needs no RPC: it renders nothing when
 * that state is absent, which is the case for every deployment without a
 * Tailscale address.
 */
window.__ModuleLoader__.load({
	id: 'dsh-simple-remote',
	factory(require) {
		const React = require('react')
		const h = React.createElement
		const NS = 'simple-remote'

		const zh = {
			title: '手机访问（Tailscale）',
			autoDesc: '同一 tailnet 内的手机可直接打开下面的地址，登录由插件自动完成。',
			tokenDesc: '请在手机上打开下面这条带令牌的链接；登录后浏览器会记住 30 天。',
			copy: '复制',
			copied: '已复制',
			copyToken: '复制带令牌的链接',
			busy: '端口 {port} 已被占用，手机暂时连不上。请关掉占用它的程序（例如另一个 DSH 实例），或改插件的 port 配置。',
			failed: '无法在 {address}:{port} 上监听（{code}），手机暂时连不上。',
		}
		const en = {
			title: 'Mobile access (Tailscale)',
			autoDesc: 'A phone on the same tailnet can open the address below; the plugin signs it in automatically.',
			tokenDesc: 'Open the tokenized link below on the phone; the browser then remembers it for 30 days.',
			copy: 'Copy',
			copied: 'Copied',
			copyToken: 'Copy tokenized link',
			busy: 'Port {port} is already in use, so the phone cannot connect. Stop the process holding it (for example another DSH instance) or change the plugin\'s port.',
			failed: 'Could not listen on {address}:{port} ({code}), so the phone cannot connect.',
		}

		const CSS_ID = 'dsh-simple-remote/RemoteAccessRow.css'
		const css = [
			'.dsr-row{border-bottom:.5px solid var(--dsw-alias-border-l2);padding:16px 0}',
			'.dsr-title{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}',
			'.dsr-desc{color:var(--dsw-alias-label-secondary);margin-top:4px;font-size:12px;line-height:18px}',
			'.dsr-line{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap}',
			'.dsr-url{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:4px 8px;color:var(--dsw-alias-label-primary);word-break:break-all}',
			'.dsr-button{font-size:12px;line-height:18px;padding:4px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font-family:inherit}',
			'.dsr-button:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
			'.dsr-secondary{margin-top:8px}',
		].join('')
		if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_ID) + ']') === null) {
			const tag = document.createElement('style')
			tag.dataset.plugin = 'dsh-simple-remote'
			tag.dataset.pluginCss = CSS_ID
			tag.textContent = css
			document.head.appendChild(tag)
		}

		/** Copy through the async clipboard, falling back to the selection command. */
		function copyText(text) {
			const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
			if (clipboard !== undefined && typeof clipboard.writeText === 'function') return clipboard.writeText(text)
			return new Promise((resolve, reject) => {
				try {
					const area = document.createElement('textarea')
					area.value = text
					area.setAttribute('readonly', '')
					area.style.position = 'fixed'
					area.style.top = '-1000px'
					area.style.opacity = '0'
					document.body.appendChild(area)
					area.select()
					const copied = document.execCommand('copy')
					document.body.removeChild(area)
					if (copied) resolve()
					else reject(new Error('copy refused'))
				} catch (error) {
					reject(error)
				}
			})
		}

		/** Replace `{name}` placeholders in a dictionary string. */
		function fill(template, values) {
			return String(template).replace(/\{(\w+)\}/g, (match, key) => (values[key] === undefined ? match : String(values[key])))
		}

		/** One General-settings row: the tailnet address and its copy control. */
		function RemoteAccessRow(props) {
			const t = typeof props.t === 'function' ? props.t : (key) => en[key] ?? key
			const state = globalThis.__DSH_SIMPLE_REMOTE__
			const [copied, setCopied] = React.useState('')
			const timer = React.useRef(0)
			React.useEffect(() => () => {
				if (timer.current !== 0) clearTimeout(timer.current)
			}, [])
			if (state === null || state === undefined || state.enabled !== true) return null
			const urls = Array.isArray(state.urls) ? state.urls : []
			if (urls.length === 0) {
				// The listener never bound: name the conflict instead of showing
				// nothing, so the phone-side silence has a visible cause.
				const error = state.error
				if (error === null || typeof error !== 'object') return null
				const text = fill(error.code === 'EADDRINUSE' ? t('busy') : t('failed'), error)
				return h('div', { className: 'dsr-row' }, [
					h('div', { className: 'dsr-title', key: 'title' }, t('title')),
					h('div', { className: 'dsr-desc', key: 'desc' }, text),
				])
			}
			const auto = state.autoToken === true
			const primary = urls[0]
			const tokenUrl = typeof state.loginUrl === 'string' ? state.loginUrl : primary
			const copy = (value, which) => {
				copyText(value).then(() => {
					setCopied(which)
					if (timer.current !== 0) clearTimeout(timer.current)
					timer.current = setTimeout(() => setCopied(''), 1600)
				}).catch(() => {})
			}
			const rows = [
				h('div', { className: 'dsr-title', key: 'title' }, t('title')),
				h('div', { className: 'dsr-desc', key: 'desc' }, auto ? t('autoDesc') : t('tokenDesc')),
				h('div', { className: 'dsr-line', key: 'line' }, [
					h('code', { className: 'dsr-url', key: 'url' }, auto ? primary : tokenUrl),
					h('button', {
						className: 'dsr-button',
						type: 'button',
						key: 'copy',
						onClick: () => copy(auto ? primary : tokenUrl, 'main'),
					}, copied === 'main' ? t('copied') : t('copy')),
				]),
			]
			if (!auto) {
				rows.push(h('button', {
					className: 'dsr-button dsr-secondary',
					type: 'button',
					key: 'token',
					onClick: () => copy(tokenUrl, 'token'),
				}, copied === 'token' ? t('copied') : t('copyToken')))
			}
			return h('div', { className: 'dsr-row' }, rows)
		}

		return {
			inject: ['slots', 'locale'],
			apply(ctx) {
				ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'simple-remote: dictionaries')
				ctx.slots.inject('settings.general.item', () => ctx.slots.register({
					name: 'settings.general.item',
					id: 'simple-remote',
					order: 95,
					locale: NS,
				}, RemoteAccessRow))
			},
		}
	},
})
