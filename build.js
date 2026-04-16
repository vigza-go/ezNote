const esbuild = require('esbuild')

esbuild.build({
    entryPoints: ['src/client.js'],
    bundle: true,
    minify: true,
    outfile: 'public/bundle.js',
    format: 'iife',
    target: ['es2020'],
    platform: 'browser',
    logLevel: 'info',
}).catch(() => process.exit(1))
