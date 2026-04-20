const { rollup } = require('rollup')
const { nodeResolve } = require('@rollup/plugin-node-resolve')
const commonjs = require('@rollup/plugin-commonjs')
const terser = require('@rollup/plugin-terser')
const path = require('path')
const fs = require('fs')

async function build() {
    // 清理旧的 chunks
    const chunksDir = path.join(__dirname, 'public', 'chunks')
    if (fs.existsSync(chunksDir)) {
        fs.rmSync(chunksDir, { recursive: true })
    }
    fs.mkdirSync(chunksDir, { recursive: true })

    const bundle = await rollup({
        input: 'src/client.js',
        plugins: [
            nodeResolve({
                browser: true,
            }),
            commonjs(),
            terser({
                compress: {
                    drop_console: true,
                },
            }),
        ],
    })

    const { output } = await bundle.write({
        dir: 'public/chunks',
        format: 'esm',
        sourcemap: false,
        entryFileNames: '[name].js',
        chunkFileNames: '[name]-[hash].js',
        manualChunks: (id) => {
            if (id.includes('node_modules')) {
                return 'vendor'
            }
        },
    })

    await bundle.close()

    // 提取 chunk 文件名并更新 index.html
    let vendorFile = ''
    let clientFile = ''
    for (const chunk of output) {
        if (chunk.type === 'chunk') {
            if (chunk.name === 'vendor') {
                vendorFile = chunk.fileName
            } else if (chunk.name === 'client') {
                clientFile = chunk.fileName
            }
        }
    }

    // 更新 index.html
    const indexPath = path.join(__dirname, 'public', 'index.html')
    let html = fs.readFileSync(indexPath, 'utf-8')
    // 替换旧的 script 标签，改为加载 vendor 和 client 模块
    html = html.replace(
        /<script src="\/bundle\.js"><\/script>/,
        `<script type="module" src="/chunks/${vendorFile}"></script>\n    <script type="module" src="/chunks/${clientFile}"></script>`
    )
    fs.writeFileSync(indexPath, html)

    console.log(`✓ 代码分割完成`)
    console.log(`  - vendor: ${vendorFile} (可长期缓存)`)
    console.log(`  - client: ${clientFile}`)
}

build().catch((err) => {
    console.error(err)
    process.exit(1)
})
