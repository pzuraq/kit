import fs__default, { readFileSync, writeFileSync } from 'fs';
import path__default, { join, dirname } from 'path';
import { p as posixify, m as mkdirp, r as rimraf } from './filesystem.js';
import { all } from './sync.js';
import { p as print_config_conflicts, b as get_aliases, r as resolve_entry, g as get_runtime_path, l as load_template } from '../cli.js';
import { g as generate_manifest } from './index3.js';
import vite from 'vite';
import { s } from './misc.js';
import { d as deep_merge } from './object.js';
import { n as normalize_path, r as resolve, i as is_root_relative } from './url.js';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { pathToFileURL, URL } from 'url';
import { installFetch } from '../install-fetch.js';
import 'sade';
import 'child_process';
import 'net';
import 'os';
import 'node:http';
import 'node:https';
import 'node:zlib';
import 'node:stream';
import 'node:util';
import 'node:url';

/**
 * @param {{
 *   cwd: string;
 *   assets_base: string;
 *   config: import('types').ValidatedConfig;
 *   manifest_data: import('types').ManifestData;
 *   output_dir: string;
 *   service_worker_entry_file: string | null;
 * }} options
 * @param {import('types').Prerendered} prerendered
 * @param {import('vite').Manifest} client_manifest
 */
async function build_service_worker(
	{ cwd, assets_base, config, manifest_data, output_dir, service_worker_entry_file },
	prerendered,
	client_manifest
) {
	// TODO add any assets referenced in template .html file, e.g. favicon?
	const app_files = new Set();
	for (const key in client_manifest) {
		const { file, css } = client_manifest[key];
		app_files.add(file);
		if (css) {
			css.forEach((file) => {
				app_files.add(file);
			});
		}
	}

	const service_worker = `${config.kit.outDir}/generated/service-worker.js`;

	fs__default.writeFileSync(
		service_worker,
		`
			// TODO remove for 1.0
			export const timestamp = {
				toString: () => {
					throw new Error('\`timestamp\` has been removed from $service-worker. Use \`version\` instead');
				}
			};

			export const build = [
				${Array.from(app_files)
					.map((file) => `${s(`${config.kit.paths.base}/${config.kit.appDir}/${file}`)}`)
					.join(',\n\t\t\t\t')}
			];

			export const files = [
				${manifest_data.assets
					.filter((asset) => config.kit.serviceWorker.files(asset.file))
					.map((asset) => `${s(`${config.kit.paths.base}/${asset.file}`)}`)
					.join(',\n\t\t\t\t')}
			];

			export const prerendered = [
				${prerendered.paths
					.map((path) => s(normalize_path(path, config.kit.trailingSlash)))
					.join(',\n\t\t\t\t')}
			];

			export const version = ${s(config.kit.version.name)};
		`
			.replace(/^\t{3}/gm, '')
			.trim()
	);

	/** @type {[any, string[]]} */
	const [merged_config, conflicts] = deep_merge(await config.kit.vite(), {
		configFile: false,
		root: cwd,
		base: assets_base,
		build: {
			lib: {
				entry: service_worker_entry_file,
				name: 'app',
				formats: ['es']
			},
			rollupOptions: {
				output: {
					entryFileNames: 'service-worker.js'
				}
			},
			outDir: `${output_dir}/client`,
			emptyOutDir: false
		},
		resolve: {
			alias: {
				'$service-worker': service_worker,
				$lib: config.kit.files.lib
			}
		}
	});

	print_config_conflicts(conflicts, 'kit.vite.', 'build_service_worker');

	await vite.build(merged_config);
}

/**
 * @typedef {import('rollup').RollupOutput} RollupOutput
 * @typedef {import('rollup').OutputChunk} OutputChunk
 * @typedef {import('rollup').OutputAsset} OutputAsset
 */

/** @param {import('vite').UserConfig} config */
async function create_build(config) {
	const { output } = /** @type {RollupOutput} */ (await vite.build(config));

	const chunks = output.filter(
		/** @returns {output is OutputChunk} */ (output) => output.type === 'chunk'
	);

	const assets = output.filter(
		/** @returns {output is OutputAsset} */ (output) => output.type === 'asset'
	);

	return { chunks, assets };
}

/**
 * @param {string} file
 * @param {import('vite').Manifest} manifest
 * @param {Set<string>} css
 * @param {Set<string>} js
 */
function find_deps(file, manifest, js, css) {
	const chunk = manifest[file];

	if (js.has(chunk.file)) return;
	js.add(chunk.file);

	if (chunk.css) {
		chunk.css.forEach((file) => css.add(file));
	}

	if (chunk.imports) {
		chunk.imports.forEach((file) => find_deps(file, manifest, js, css));
	}
}

/**
 * @param {{
 *   cwd: string;
 *   assets_base: string;
 *   config: import('types').ValidatedConfig
 *   manifest_data: import('types').ManifestData
 *   output_dir: string;
 *   client_entry_file: string;
 *   service_worker_entry_file: string | null;
 *   service_worker_register: boolean;
 * }} options
 */
async function build_client({
	cwd,
	assets_base,
	config,
	manifest_data,
	output_dir,
	client_entry_file
}) {
	process.env.VITE_SVELTEKIT_APP_VERSION = config.kit.version.name;
	process.env.VITE_SVELTEKIT_APP_VERSION_FILE = `${config.kit.appDir}/version.json`;
	process.env.VITE_SVELTEKIT_APP_VERSION_POLL_INTERVAL = `${config.kit.version.pollInterval}`;

	process.env.VITE_SVELTEKIT_AMP = config.kit.amp ? 'true' : '';

	const client_out_dir = `${output_dir}/client/${config.kit.appDir}`;

	/** @type {Record<string, string>} */
	const input = {
		start: path__default.resolve(cwd, client_entry_file)
	};

	// This step is optional — Vite/Rollup will create the necessary chunks
	// for everything regardless — but it means that entry chunks reflect
	// their location in the source code, which is helpful for debugging
	manifest_data.components.forEach((file) => {
		const resolved = path__default.resolve(cwd, file);
		const relative = path__default.relative(config.kit.files.routes, resolved);

		const name = relative.startsWith('..')
			? path__default.basename(file)
			: posixify(path__default.join('pages', relative));
		input[name] = resolved;
	});

	/** @type {[any, string[]]} */
	const [merged_config, conflicts] = deep_merge(await config.kit.vite(), {
		configFile: false,
		root: cwd,
		base: assets_base,
		build: {
			cssCodeSplit: true,
			manifest: true,
			outDir: client_out_dir,
			polyfillDynamicImport: false,
			rollupOptions: {
				input,
				output: {
					entryFileNames: '[name]-[hash].js',
					chunkFileNames: 'chunks/[name]-[hash].js',
					assetFileNames: 'assets/[name]-[hash][extname]'
				},
				preserveEntrySignatures: 'strict'
			}
		},
		resolve: {
			alias: get_aliases(config)
		},
		plugins: [
			svelte({
				extensions: config.extensions,
				// In AMP mode, we know that there are no conditional component imports. In that case, we
				// don't need to include CSS for components that are imported but unused, so we can just
				// include rendered CSS.
				// This would also apply if hydrate and router are both false, but we don't know if one
				// has been enabled at the page level, so we don't do anything there.
				emitCss: !config.kit.amp,
				compilerOptions: {
					hydratable: !!config.kit.browser.hydrate
				}
			})
		],
		// prevent Vite copying the contents of `config.kit.files.assets`,
		// if it happens to be 'public' instead of 'static'
		publicDir: false
	});

	print_config_conflicts(conflicts, 'kit.vite.', 'build_client');

	const { chunks, assets } = await create_build(merged_config);

	/** @type {import('vite').Manifest} */
	const vite_manifest = JSON.parse(fs__default.readFileSync(`${client_out_dir}/manifest.json`, 'utf-8'));

	const entry = posixify(client_entry_file);
	const entry_js = new Set();
	const entry_css = new Set();
	find_deps(entry, vite_manifest, entry_js, entry_css);

	fs__default.writeFileSync(
		`${client_out_dir}/version.json`,
		JSON.stringify({ version: process.env.VITE_SVELTEKIT_APP_VERSION })
	);

	return {
		assets,
		chunks,
		entry: {
			file: vite_manifest[entry].file,
			js: Array.from(entry_js),
			css: Array.from(entry_css)
		},
		vite_manifest
	};
}

/**
 * @param {{
 *   hooks: string;
 *   config: import('types').ValidatedConfig;
 *   has_service_worker: boolean;
 *   runtime: string;
 *   template: string;
 * }} opts
 */
const server_template = ({ config, hooks, has_service_worker, runtime, template }) => `
import root from '__GENERATED__/root.svelte';
import { respond } from '${runtime}/server/index.js';
import { set_paths, assets, base } from '${runtime}/paths.js';
import { set_prerendering } from '${runtime}/env.js';
import * as user_hooks from ${s(hooks)};

const template = ({ head, body, assets, nonce }) => ${s(template)
	.replace('%svelte.head%', '" + head + "')
	.replace('%svelte.body%', '" + body + "')
	.replace(/%svelte\.assets%/g, '" + assets + "')
	.replace(/%svelte\.nonce%/g, '" + nonce + "')};

let read = null;

set_paths(${s(config.kit.paths)});

let default_protocol = 'https';

// allow paths to be globally overridden
// in svelte-kit preview and in prerendering
export function override(settings) {
	default_protocol = settings.protocol || default_protocol;
	set_paths(settings.paths);
	set_prerendering(settings.prerendering);
	read = settings.read;
}

export class Server {
	constructor(manifest) {
		this.options = {
			amp: ${config.kit.amp},
			csp: ${s(config.kit.csp)},
			dev: false,
			floc: ${config.kit.floc},
			get_stack: error => String(error), // for security
			handle_error: (error, event) => {
				this.options.hooks.handleError({
					error,
					event,

					// TODO remove for 1.0
					// @ts-expect-error
					get request() {
						throw new Error('request in handleError has been replaced with event. See https://github.com/sveltejs/kit/pull/3384 for details');
					}
				});
				error.stack = this.options.get_stack(error);
			},
			hooks: null,
			hydrate: ${s(config.kit.browser.hydrate)},
			manifest,
			method_override: ${s(config.kit.methodOverride)},
			paths: { base, assets },
			prefix: assets + '/${config.kit.appDir}/',
			prerender: ${config.kit.prerender.enabled},
			read,
			root,
			service_worker: ${has_service_worker ? "base + '/service-worker.js'" : 'null'},
			router: ${s(config.kit.browser.router)},
			template,
			template_contains_nonce: ${template.includes('%svelte.nonce%')},
			trailing_slash: ${s(config.kit.trailingSlash)}
		};
	}

	async respond(request, options = {}) {
		if (!(request instanceof Request)) {
			throw new Error('The first argument to server.respond must be a Request object. See https://github.com/sveltejs/kit/pull/3384 for details');
		}

		if (!this.options.hooks) {
			const module = await import(${s(hooks)});
			this.options.hooks = {
				getSession: module.getSession || (() => ({})),
				handle: module.handle || (({ event, resolve }) => resolve(event)),
				handleError: module.handleError || (({ error }) => console.error(error.stack)),
				externalFetch: module.externalFetch || fetch
			};
		}

		return respond(request, this.options, options);
	}
}
`;

/**
 * @param {{
 *   cwd: string;
 *   assets_base: string;
 *   config: import('types').ValidatedConfig
 *   manifest_data: import('types').ManifestData
 *   build_dir: string;
 *   output_dir: string;
 *   service_worker_entry_file: string | null;
 *   service_worker_register: boolean;
 * }} options
 * @param {{ vite_manifest: import('vite').Manifest, assets: import('rollup').OutputAsset[] }} client
 */
async function build_server(
	{
		cwd,
		assets_base,
		config,
		manifest_data,
		build_dir,
		output_dir,
		service_worker_entry_file,
		service_worker_register
	},
	client
) {
	let hooks_file = resolve_entry(config.kit.files.hooks);
	if (!hooks_file || !fs__default.existsSync(hooks_file)) {
		hooks_file = path__default.join(config.kit.outDir, 'build/hooks.js');
		fs__default.writeFileSync(hooks_file, '');
	}

	/** @type {Record<string, string>} */
	const input = {
		index: `${build_dir}/index.js`
	};

	// add entry points for every endpoint...
	manifest_data.routes.forEach((route) => {
		const file = route.type === 'endpoint' ? route.file : route.shadow;

		if (file) {
			const resolved = path__default.resolve(cwd, file);
			const relative = path__default.relative(config.kit.files.routes, resolved);
			const name = posixify(path__default.join('entries/endpoints', relative.replace(/\.js$/, '')));
			input[name] = resolved;
		}
	});

	// ...and every component used by pages...
	manifest_data.components.forEach((file) => {
		const resolved = path__default.resolve(cwd, file);
		const relative = path__default.relative(config.kit.files.routes, resolved);

		const name = relative.startsWith('..')
			? posixify(path__default.join('entries/fallbacks', path__default.basename(file)))
			: posixify(path__default.join('entries/pages', relative));
		input[name] = resolved;
	});

	// ...and every matcher
	Object.entries(manifest_data.matchers).forEach(([key, file]) => {
		const name = posixify(path__default.join('entries/matchers', key));
		input[name] = path__default.resolve(cwd, file);
	});

	/** @type {(file: string) => string} */
	const app_relative = (file) => {
		const relative_file = path__default.relative(build_dir, path__default.resolve(cwd, file));
		return relative_file[0] === '.' ? relative_file : `./${relative_file}`;
	};

	fs__default.writeFileSync(
		input.index,
		server_template({
			config,
			hooks: app_relative(hooks_file),
			has_service_worker: service_worker_register && !!service_worker_entry_file,
			runtime: get_runtime_path(config),
			template: load_template(cwd, config)
		})
	);

	/** @type {import('vite').UserConfig} */
	const vite_config = await config.kit.vite();

	const default_config = {
		build: {
			target: 'es2020'
		}
	};

	// don't warn on overriding defaults
	const [modified_vite_config] = deep_merge(default_config, vite_config);

	/** @type {[any, string[]]} */
	const [merged_config, conflicts] = deep_merge(modified_vite_config, {
		configFile: false,
		root: cwd,
		base: assets_base,
		build: {
			ssr: true,
			outDir: `${output_dir}/server`,
			manifest: true,
			polyfillDynamicImport: false,
			rollupOptions: {
				input,
				output: {
					format: 'esm',
					entryFileNames: '[name].js',
					chunkFileNames: 'chunks/[name]-[hash].js',
					assetFileNames: 'assets/[name]-[hash][extname]'
				},
				preserveEntrySignatures: 'strict'
			}
		},
		plugins: [
			svelte({
				extensions: config.extensions,
				compilerOptions: {
					hydratable: !!config.kit.browser.hydrate
				}
			})
		],
		resolve: {
			alias: get_aliases(config)
		}
	});

	print_config_conflicts(conflicts, 'kit.vite.', 'build_server');

	process.env.VITE_SVELTEKIT_ADAPTER_NAME = config.kit.adapter?.name;

	const { chunks } = await create_build(merged_config);

	/** @type {import('vite').Manifest} */
	const vite_manifest = JSON.parse(fs__default.readFileSync(`${output_dir}/server/manifest.json`, 'utf-8'));

	mkdirp(`${output_dir}/server/nodes`);
	mkdirp(`${output_dir}/server/stylesheets`);

	const stylesheet_lookup = new Map();

	client.assets.forEach((asset) => {
		if (asset.fileName.endsWith('.css')) {
			if (config.kit.amp || asset.source.length < config.kit.inlineStyleThreshold) {
				const index = stylesheet_lookup.size;
				const file = `${output_dir}/server/stylesheets/${index}.js`;

				fs__default.writeFileSync(file, `// ${asset.fileName}\nexport default ${s(asset.source)};`);
				stylesheet_lookup.set(asset.fileName, index);
			}
		}
	});

	manifest_data.components.forEach((component, i) => {
		const file = `${output_dir}/server/nodes/${i}.js`;

		const js = new Set();
		const css = new Set();
		find_deps(component, client.vite_manifest, js, css);

		const imports = [`import * as module from '../${vite_manifest[component].file}';`];

		const exports = [
			'export { module };',
			`export const entry = '${client.vite_manifest[component].file}';`,
			`export const js = ${s(Array.from(js))};`,
			`export const css = ${s(Array.from(css))};`
		];

		/** @type {string[]} */
		const styles = [];

		css.forEach((file) => {
			if (stylesheet_lookup.has(file)) {
				const index = stylesheet_lookup.get(file);
				const name = `stylesheet_${index}`;
				imports.push(`import ${name} from '../stylesheets/${index}.js';`);
				styles.push(`\t${s(file)}: ${name}`);
			}
		});

		if (styles.length > 0) {
			exports.push(`export const styles = {\n${styles.join(',\n')}\n};`);
		}

		fs__default.writeFileSync(file, `${imports.join('\n')}\n\n${exports.join('\n')}\n`);
	});

	return {
		chunks,
		vite_manifest,
		methods: get_methods(cwd, chunks, manifest_data)
	};
}

/** @type {Record<string, string>} */
const method_names = {
	get: 'get',
	head: 'head',
	post: 'post',
	put: 'put',
	del: 'delete',
	patch: 'patch'
};

/**
 * @param {string} cwd
 * @param {import('rollup').OutputChunk[]} output
 * @param {import('types').ManifestData} manifest_data
 */
function get_methods(cwd, output, manifest_data) {
	/** @type {Record<string, string[]>} */
	const lookup = {};
	output.forEach((chunk) => {
		if (!chunk.facadeModuleId) return;
		const id = chunk.facadeModuleId.slice(cwd.length + 1);
		lookup[id] = chunk.exports;
	});

	/** @type {Record<string, import('types').HttpMethod[]>} */
	const methods = {};
	manifest_data.routes.forEach((route) => {
		const file = route.type === 'endpoint' ? route.file : route.shadow;

		if (file && lookup[file]) {
			methods[file] = lookup[file]
				.map((x) => /** @type {import('types').HttpMethod} */ (method_names[x]))
				.filter(Boolean);
		}
	});

	return methods;
}

/** @typedef {{
 *   fn: () => Promise<any>,
 *   fulfil: (value: any) => void,
 *   reject: (error: Error) => void
 * }} Task */

/** @param {number} concurrency */
function queue(concurrency) {
	/** @type {Task[]} */
	const tasks = [];

	let current = 0;

	/** @type {(value?: any) => void} */
	let fulfil;

	/** @type {(error: Error) => void} */
	let reject;

	let closed = false;

	const done = new Promise((f, r) => {
		fulfil = f;
		reject = r;
	});

	done.catch(() => {
		// this is necessary in case a catch handler is never added
		// to the done promise by the user
	});

	function dequeue() {
		if (current < concurrency) {
			const task = tasks.shift();

			if (task) {
				current += 1;
				const promise = Promise.resolve(task.fn());

				promise
					.then(task.fulfil, (err) => {
						task.reject(err);
						reject(err);
					})
					.then(() => {
						current -= 1;
						dequeue();
					});
			} else if (current === 0) {
				closed = true;
				fulfil();
			}
		}
	}

	return {
		/** @param {() => any} fn */
		add: (fn) => {
			if (closed) throw new Error('Cannot add tasks to a queue that has ended');

			const promise = new Promise((fulfil, reject) => {
				tasks.push({ fn, fulfil, reject });
			});

			dequeue();
			return promise;
		},

		done: () => {
			if (current === 0) {
				closed = true;
				fulfil();
			}

			return done;
		}
	};
}

const DOCTYPE = 'DOCTYPE';
const CDATA_OPEN = '[CDATA[';
const CDATA_CLOSE = ']]>';
const COMMENT_OPEN = '--';
const COMMENT_CLOSE = '-->';

const TAG_OPEN = /[a-zA-Z]/;
const TAG_CHAR = /[a-zA-Z0-9]/;
const ATTRIBUTE_NAME = /[^\t\n\f />"'=]/;

const WHITESPACE = /[\s\n\r]/;

/** @param {string} html */
function crawl(html) {
	/** @type {string[]} */
	const hrefs = [];

	let i = 0;
	main: while (i < html.length) {
		const char = html[i];

		if (char === '<') {
			if (html[i + 1] === '!') {
				i += 2;

				if (html.slice(i, i + DOCTYPE.length).toUpperCase() === DOCTYPE) {
					i += DOCTYPE.length;
					while (i < html.length) {
						if (html[i++] === '>') {
							continue main;
						}
					}
				}

				// skip cdata
				if (html.slice(i, i + CDATA_OPEN.length) === CDATA_OPEN) {
					i += CDATA_OPEN.length;
					while (i < html.length) {
						if (html.slice(i, i + CDATA_CLOSE.length) === CDATA_CLOSE) {
							i += CDATA_CLOSE.length;
							continue main;
						}

						i += 1;
					}
				}

				// skip comments
				if (html.slice(i, i + COMMENT_OPEN.length) === COMMENT_OPEN) {
					i += COMMENT_OPEN.length;
					while (i < html.length) {
						if (html.slice(i, i + COMMENT_CLOSE.length) === COMMENT_CLOSE) {
							i += COMMENT_CLOSE.length;
							continue main;
						}

						i += 1;
					}
				}
			}

			// parse opening tags
			const start = ++i;
			if (TAG_OPEN.test(html[start])) {
				while (i < html.length) {
					if (!TAG_CHAR.test(html[i])) {
						break;
					}

					i += 1;
				}

				const tag = html.slice(start, i).toUpperCase();

				if (tag === 'SCRIPT' || tag === 'STYLE') {
					while (i < html.length) {
						if (
							html[i] === '<' &&
							html[i + 1] === '/' &&
							html.slice(i + 2, i + 2 + tag.length).toUpperCase() === tag
						) {
							continue main;
						}

						i += 1;
					}
				}

				let href = '';
				let rel = '';

				while (i < html.length) {
					const start = i;

					const char = html[start];
					if (char === '>') break;

					if (ATTRIBUTE_NAME.test(char)) {
						i += 1;

						while (i < html.length) {
							if (!ATTRIBUTE_NAME.test(html[i])) {
								break;
							}

							i += 1;
						}

						const name = html.slice(start, i).toLowerCase();

						while (WHITESPACE.test(html[i])) i += 1;

						if (html[i] === '=') {
							i += 1;
							while (WHITESPACE.test(html[i])) i += 1;

							let value;

							if (html[i] === "'" || html[i] === '"') {
								const quote = html[i++];

								const start = i;
								let escaped = false;

								while (i < html.length) {
									if (!escaped) {
										const char = html[i];

										if (html[i] === quote) {
											break;
										}

										if (char === '\\') {
											escaped = true;
										}
									}

									i += 1;
								}

								value = html.slice(start, i);
							} else {
								const start = i;
								while (html[i] !== '>' && !WHITESPACE.test(html[i])) i += 1;
								value = html.slice(start, i);

								i -= 1;
							}

							if (name === 'href') {
								href = value;
							} else if (name === 'rel') {
								rel = value;
							} else if (name === 'src') {
								hrefs.push(value);
							} else if (name === 'srcset') {
								const candidates = [];
								let insideURL = true;
								value = value.trim();
								for (let i = 0; i < value.length; i++) {
									if (value[i] === ',' && (!insideURL || (insideURL && value[i + 1] === ' '))) {
										candidates.push(value.slice(0, i));
										value = value.substring(i + 1).trim();
										i = 0;
										insideURL = true;
									} else if (value[i] === ' ') {
										insideURL = false;
									}
								}
								candidates.push(value);
								for (const candidate of candidates) {
									const src = candidate.split(WHITESPACE)[0];
									hrefs.push(src);
								}
							}
						} else {
							i -= 1;
						}
					}

					i += 1;
				}

				if (href && !/\bexternal\b/i.test(rel)) {
					hrefs.push(href);
				}
			}
		}

		i += 1;
	}

	return hrefs;
}

/**
 * Inside a script element, only `</script` and `<!--` hold special meaning to the HTML parser.
 *
 * The first closes the script element, so everything after is treated as raw HTML.
 * The second disables further parsing until `-->`, so the script element might be unexpectedly
 * kept open until until an unrelated HTML comment in the page.
 *
 * U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR are escaped for the sake of pre-2018
 * browsers.
 *
 * @see tests for unsafe parsing examples.
 * @see https://html.spec.whatwg.org/multipage/scripting.html#restrictions-for-contents-of-script-elements
 * @see https://html.spec.whatwg.org/multipage/syntax.html#cdata-rcdata-restrictions
 * @see https://html.spec.whatwg.org/multipage/parsing.html#script-data-state
 * @see https://html.spec.whatwg.org/multipage/parsing.html#script-data-double-escaped-state
 * @see https://github.com/tc39/proposal-json-superset
 * @type {Record<string, string>}
 */
const render_json_payload_script_dict = {
	'<': '\\u003C',
	'\u2028': '\\u2028',
	'\u2029': '\\u2029'
};

new RegExp(
	`[${Object.keys(render_json_payload_script_dict).join('')}]`,
	'g'
);

/**
 * When inside a double-quoted attribute value, only `&` and `"` hold special meaning.
 * @see https://html.spec.whatwg.org/multipage/parsing.html#attribute-value-(double-quoted)-state
 * @type {Record<string, string>}
 */
const escape_html_attr_dict = {
	'&': '&amp;',
	'"': '&quot;'
};

const escape_html_attr_regex = new RegExp(
	// special characters
	`[${Object.keys(escape_html_attr_dict).join('')}]|` +
		// high surrogate without paired low surrogate
		'[\\ud800-\\udbff](?![\\udc00-\\udfff])|' +
		// a valid surrogate pair, the only match with 2 code units
		// we match it so that we can match unpaired low surrogates in the same pass
		// TODO: use lookbehind assertions once they are widely supported: (?<![\ud800-udbff])[\udc00-\udfff]
		'[\\ud800-\\udbff][\\udc00-\\udfff]|' +
		// unpaired low surrogate (see previous match)
		'[\\udc00-\\udfff]',
	'g'
);

/**
 * Formats a string to be used as an attribute's value in raw HTML.
 *
 * It escapes unpaired surrogates (which are allowed in js strings but invalid in HTML), escapes
 * characters that are special in attributes, and surrounds the whole string in double-quotes.
 *
 * @param {string} str
 * @returns {string} Escaped string surrounded by double-quotes.
 * @example const html = `<tag data-value=${escape_html_attr('value')}>...</tag>`;
 */
function escape_html_attr(str) {
	const escaped_str = str.replace(escape_html_attr_regex, (match) => {
		if (match.length === 2) {
			// valid surrogate pair
			return match;
		}

		return escape_html_attr_dict[match] ?? `&#${match.charCodeAt(0)};`;
	});

	return `"${escaped_str}"`;
}

/**
 * @typedef {import('types').PrerenderErrorHandler} PrerenderErrorHandler
 * @typedef {import('types').PrerenderOnErrorValue} OnError
 * @typedef {import('types').Logger} Logger
 */

/** @type {(details: Parameters<PrerenderErrorHandler>[0] ) => string} */
function format_error({ status, path, referrer, referenceType }) {
	return `${status} ${path}${referrer ? ` (${referenceType} from ${referrer})` : ''}`;
}

/** @type {(log: Logger, onError: OnError) => PrerenderErrorHandler} */
function normalise_error_handler(log, onError) {
	switch (onError) {
		case 'continue':
			return (details) => {
				log.error(format_error(details));
			};
		case 'fail':
			return (details) => {
				throw new Error(format_error(details));
			};
		default:
			return onError;
	}
}

const OK = 2;
const REDIRECT = 3;

/**
 * @param {{
 *   config: import('types').ValidatedConfig;
 *   entries: string[];
 *   files: Set<string>;
 *   log: Logger;
 * }} opts
 */
async function prerender({ config, entries, files, log }) {
	/** @type {import('types').Prerendered} */
	const prerendered = {
		pages: new Map(),
		assets: new Map(),
		redirects: new Map(),
		paths: []
	};

	installFetch();

	const server_root = join(config.kit.outDir, 'output');

	/** @type {import('types').ServerModule} */
	const { Server, override } = await import(pathToFileURL(`${server_root}/server/index.js`).href);
	const { manifest } = await import(pathToFileURL(`${server_root}/server/manifest.js`).href);

	override({
		paths: config.kit.paths,
		prerendering: true,
		read: (file) => readFileSync(join(config.kit.files.assets, file))
	});

	const server = new Server(manifest);

	const rendered = await server.respond(new Request('http://sveltekit-prerender/[fallback]'), {
		getClientAddress,
		prerender: {
			fallback: true,
			default: false,
			dependencies: new Map()
		}
	});

	const file = `${config.kit.outDir}/output/prerendered/fallback.html`;
	mkdirp(dirname(file));
	writeFileSync(file, await rendered.text());

	if (!config.kit.prerender.enabled) {
		return prerendered;
	}

	const error = normalise_error_handler(log, config.kit.prerender.onError);

	const q = queue(config.kit.prerender.concurrency);

	/**
	 * @param {string} path
	 * @param {boolean} is_html
	 */
	function output_filename(path, is_html) {
		const file = path.slice(config.kit.paths.base.length + 1);

		if (file === '') {
			return 'index.html';
		}

		if (is_html && !file.endsWith('.html')) {
			return file + (config.kit.trailingSlash === 'always' ? 'index.html' : '.html');
		}

		return file;
	}

	const seen = new Set();
	const written = new Set();

	/**
	 * @param {string | null} referrer
	 * @param {string} decoded
	 * @param {string} [encoded]
	 */
	function enqueue(referrer, decoded, encoded) {
		if (seen.has(decoded)) return;
		seen.add(decoded);

		const file = decoded.slice(config.kit.paths.base.length + 1);
		if (files.has(file)) return;

		return q.add(() => visit(decoded, encoded || encodeURI(decoded), referrer));
	}

	/**
	 * @param {string} decoded
	 * @param {string} encoded
	 * @param {string?} referrer
	 */
	async function visit(decoded, encoded, referrer) {
		if (!decoded.startsWith(config.kit.paths.base)) {
			error({ status: 404, path: decoded, referrer, referenceType: 'linked' });
			return;
		}

		/** @type {Map<string, import('types').PrerenderDependency>} */
		const dependencies = new Map();

		const response = await server.respond(new Request(`http://sveltekit-prerender${encoded}`), {
			getClientAddress,
			prerender: {
				default: config.kit.prerender.default,
				dependencies
			}
		});

		const text = await response.text();

		save('pages', response, text, decoded, encoded, referrer, 'linked');

		for (const [dependency_path, result] of dependencies) {
			// this seems circuitous, but using new URL allows us to not care
			// whether dependency_path is encoded or not
			const encoded_dependency_path = new URL(dependency_path, 'http://localhost').pathname;
			const decoded_dependency_path = decodeURI(encoded_dependency_path);

			const body = result.body ?? new Uint8Array(await result.response.arrayBuffer());
			save(
				'dependencies',
				result.response,
				body,
				decoded_dependency_path,
				encoded_dependency_path,
				decoded,
				'fetched'
			);
		}

		if (config.kit.prerender.crawl && response.headers.get('content-type') === 'text/html') {
			for (const href of crawl(text)) {
				if (href.startsWith('data:') || href.startsWith('#')) continue;

				const resolved = resolve(encoded, href);
				if (!is_root_relative(resolved)) continue;

				const parsed = new URL(resolved, 'http://localhost');

				if (parsed.search) ;

				const pathname = normalize_path(parsed.pathname, config.kit.trailingSlash);
				enqueue(decoded, decodeURI(pathname), pathname);
			}
		}
	}

	/**
	 * @param {'pages' | 'dependencies'} category
	 * @param {Response} response
	 * @param {string | Uint8Array} body
	 * @param {string} decoded
	 * @param {string} encoded
	 * @param {string | null} referrer
	 * @param {'linked' | 'fetched'} referenceType
	 */
	function save(category, response, body, decoded, encoded, referrer, referenceType) {
		const response_type = Math.floor(response.status / 100);
		const type = /** @type {string} */ (response.headers.get('content-type'));
		const is_html = response_type === REDIRECT || type === 'text/html';

		const file = output_filename(decoded, is_html);
		const dest = `${config.kit.outDir}/output/prerendered/${category}/${file}`;

		if (written.has(file)) return;
		written.add(file);

		if (response_type === REDIRECT) {
			const location = response.headers.get('location');

			if (location) {
				mkdirp(dirname(dest));

				log.warn(`${response.status} ${decoded} -> ${location}`);

				writeFileSync(
					dest,
					`<meta http-equiv="refresh" content=${escape_html_attr(`0;url=${location}`)}>`
				);

				let resolved = resolve(encoded, location);
				if (is_root_relative(resolved)) {
					resolved = normalize_path(resolved, config.kit.trailingSlash);
					enqueue(decoded, decodeURI(resolved), resolved);
				}

				if (!prerendered.redirects.has(decoded)) {
					prerendered.redirects.set(decoded, {
						status: response.status,
						location: resolved
					});

					prerendered.paths.push(normalize_path(decoded, 'never'));
				}
			} else {
				log.warn(`location header missing on redirect received from ${decoded}`);
			}

			return;
		}

		if (response.status === 200) {
			mkdirp(dirname(dest));

			log.info(`${response.status} ${decoded}`);
			writeFileSync(dest, body);

			if (is_html) {
				prerendered.pages.set(decoded, {
					file
				});
			} else {
				prerendered.assets.set(decoded, {
					type
				});
			}

			prerendered.paths.push(normalize_path(decoded, 'never'));
		} else if (response_type !== OK) {
			error({ status: response.status, path: decoded, referrer, referenceType });
		}
	}

	if (config.kit.prerender.enabled) {
		for (const entry of config.kit.prerender.entries) {
			if (entry === '*') {
				for (const entry of entries) {
					enqueue(null, normalize_path(config.kit.paths.base + entry, config.kit.trailingSlash)); // TODO can we pre-normalize these?
				}
			} else {
				enqueue(null, normalize_path(config.kit.paths.base + entry, config.kit.trailingSlash));
			}
		}

		await q.done();
	}

	return prerendered;
}

/** @return {string} */
function getClientAddress() {
	throw new Error('Cannot read clientAddress during prerendering');
}

/**
 * @param {import('types').ValidatedConfig} config
 * @param {{ log: import('types').Logger }} opts
 */
async function build(config, { log }) {
	const cwd = process.cwd(); // TODO is this necessary?

	const build_dir = path__default.join(config.kit.outDir, 'build');
	rimraf(build_dir);
	mkdirp(build_dir);

	const output_dir = path__default.join(config.kit.outDir, 'output');
	rimraf(output_dir);
	mkdirp(output_dir);

	const { manifest_data } = all(config);

	const options = {
		cwd,
		config,
		build_dir,
		// TODO this is so that Vite's preloading works. Unfortunately, it fails
		// during `svelte-kit preview`, because we use a local asset path. If Vite
		// used relative paths, I _think_ this could get fixed. Issue here:
		// https://github.com/vitejs/vite/issues/2009
		assets_base: `${config.kit.paths.assets || config.kit.paths.base}/${config.kit.appDir}/`,
		manifest_data,
		output_dir,
		client_entry_file: path__default.relative(cwd, `${get_runtime_path(config)}/client/start.js`),
		service_worker_entry_file: resolve_entry(config.kit.files.serviceWorker),
		service_worker_register: config.kit.serviceWorker.register
	};

	const client = await build_client(options);
	const server = await build_server(options, client);

	/** @type {import('types').BuildData} */
	const build_data = {
		app_dir: config.kit.appDir,
		manifest_data: options.manifest_data,
		service_worker: options.service_worker_entry_file ? 'service-worker.js' : null, // TODO make file configurable?
		client,
		server
	};

	const manifest = `export const manifest = ${generate_manifest({
		build_data,
		relative_path: '.',
		routes: options.manifest_data.routes
	})};\n`;
	fs__default.writeFileSync(`${output_dir}/server/manifest.js`, manifest);

	const static_files = options.manifest_data.assets.map((asset) => posixify(asset.file));

	const files = new Set([
		...static_files,
		...client.chunks.map((chunk) => `${config.kit.appDir}/${chunk.fileName}`),
		...client.assets.map((chunk) => `${config.kit.appDir}/${chunk.fileName}`)
	]);

	// TODO is this right?
	static_files.forEach((file) => {
		if (file.endsWith('/index.html')) {
			files.add(file.slice(0, -11));
		}
	});

	const prerendered = await prerender({
		config,
		entries: options.manifest_data.routes
			.map((route) => (route.type === 'page' ? route.path : ''))
			.filter(Boolean),
		files,
		log
	});

	if (options.service_worker_entry_file) {
		if (config.kit.paths.assets) {
			throw new Error('Cannot use service worker alongside config.kit.paths.assets');
		}

		await build_service_worker(options, prerendered, client.vite_manifest);
	}

	return { build_data, prerendered };
}

export { build };
