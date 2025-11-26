const HtmlWebpackPlugin = require("html-webpack-plugin")
const NodePolyfillPlugin = require("node-polyfill-webpack-plugin")
const CopyPlugin = require("copy-webpack-plugin")

module.exports = [
    {
        mode: "development",
        entry: "./src/electron.ts",
        target: "electron-main",
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    include: /src/,
                    resolve: {
                        extensions: [".ts", ".js"],
                    },
                    use: [{
                        loader: "ts-loader",
                        options: {
                            configFile: "tsconfig.main.json",
                            onlyCompileBundledFiles: true,
                            transpileOnly: true
                        }
                    }],
                },
            ],
        },
        output: {
            devtoolModuleFilenameTemplate: "[absolute-resource-path]",
            path: __dirname + "/dist",
            filename: "electron.js",
        },
        node: {
            __dirname: false,
        },
    },
    {
        mode: "production",
        entry: "./src/preload.ts",
        target: "electron-preload",
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    include: /src/,
                    resolve: {
                        extensions: [".ts", ".js"],
                    },
                    use: [{
                        loader: "ts-loader",
                        options: {
                            configFile: "tsconfig.main.json",
                            onlyCompileBundledFiles: true,
                            transpileOnly: true
                        }
                    }],
                },
            ],
        },
        output: {
            path: __dirname + "/dist",
            filename: "preload.js",
        },
    },
    {
        mode: "development",
        entry: "./src/index.tsx",
        target: "web",
        devtool: "source-map",
        performance: {
            hints: false,
        },
        module: {
            rules: [
                {
                    test: /\.ts(x?)$/,
                    include: /src/,
                    resolve: {
                        extensions: [".ts", ".tsx", ".js"],
                    },
                    use: [{
                        loader: "ts-loader",
                        options: {
                            configFile: "tsconfig.renderer.json",
                            onlyCompileBundledFiles: true,
                            transpileOnly: true
                        }
                    }],
                },
            ],
        },
        output: {
            path: __dirname + "/dist",
            filename: "index.js",
        },
        plugins: [
            new NodePolyfillPlugin(),
            new HtmlWebpackPlugin({
                template: "./src/index.html",
            }),
            new CopyPlugin({
                patterns: [
                    {
                        from: "src/renderer/webview-preload.js",
                        to: "webview-preload.js",
                    },
                ],
            }),
        ],
    },
]
