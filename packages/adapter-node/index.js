import {
	createReadStream,
	createWriteStream,
	existsSync,
	statSync,
	writeFileSync
} from 'fs';
import { join } from 'path';
import { pipeline } from 'stream';
import glob from 'tiny-glob';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import zlib from 'zlib';

const pipe = promisify(pipeline);

/**
 * @typedef {import('esbuild').BuildOptions} BuildOptions
 */

/** @type {import('.')} */
export default function ({
	entryPoint = '.svelte-kit/node/index.js',
	out = 'build',
	precompress,
	env: { path: path_env = 'SOCKET_PATH', host: host_env = 'HOST', port: port_env = 'PORT' } = {}
} = {}) {
	return {
		name: '@sveltejs/adapter-node',

		async adapt({ utils, config }) {
			utils.rimraf(out);

			utils.log.minor('Copying assets');
			const static_directory = join(out, 'assets');
			utils.copy_client_files(static_directory);
			utils.copy_static_files(static_directory);

			if (precompress) {
				utils.log.minor('Compressing assets');
				await compress(static_directory);
			}

			utils.log.minor('Building SvelteKit middleware');
			const files = fileURLToPath(new URL('./files', import.meta.url));
			utils.copy(files, '.svelte-kit/node');
			writeFileSync(
				'.svelte-kit/node/env.js',
				`export const path = process.env[${JSON.stringify(
					path_env
				)}] || false;\nexport const host = process.env[${JSON.stringify(
					host_env
				)}] || '0.0.0.0';\nexport const port = process.env[${JSON.stringify(
					port_env
				)}] || (!path && 3000);`
			);

			utils.copy('.svelte-kit/output/server/app.js', 'build/index.js');

			utils.log.minor('Prerendering static pages');
			await utils.prerender({
				dest: `${out}/prerendered`
			});
			if (precompress && existsSync(`${out}/prerendered`)) {
				utils.log.minor('Compressing prerendered pages');
				await compress(`${out}/prerendered`);
			}
		}
	};
}

/**
 * @param {string} directory
 */
async function compress(directory) {
	const files = await glob('**/*.{html,js,json,css,svg,xml}', {
		cwd: directory,
		dot: true,
		absolute: true,
		filesOnly: true
	});

	await Promise.all(
		files.map((file) => Promise.all([compress_file(file, 'gz'), compress_file(file, 'br')]))
	);
}

/**
 * @param {string} file
 * @param {'gz' | 'br'} format
 */
async function compress_file(file, format = 'gz') {
	const compress =
		format == 'br'
			? zlib.createBrotliCompress({
					params: {
						[zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
						[zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
						[zlib.constants.BROTLI_PARAM_SIZE_HINT]: statSync(file).size
					}
			  })
			: zlib.createGzip({ level: zlib.constants.Z_BEST_COMPRESSION });

	const source = createReadStream(file);
	const destination = createWriteStream(`${file}.${format}`);

	await pipe(source, compress, destination);
}
