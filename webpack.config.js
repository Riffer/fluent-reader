const HtmlWebpackPlugin = require("html-webpack-plugin")
//const HardSourceWebpackPlugin = require("hard-source-webpack-plugin")
const NodePolyfillPlugin = require("node-polyfill-webpack-plugin")

module.exports = [
    {
        mode: "production",
        entry: "./src/electron.ts",
        target: "electron-main",
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    include: /src/,
                    resolve: {
                        extensions: [".ts", ".js"],
                        fallback: { "timers": require.resolve("timers-browserify") },
                    },
                    use: [{ loader: "ts-loader" }],
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
        cache: {
            type: 'filesystem',
            buildDependencies: {
                config: [__filename]
            }
        },
        plugins: [new NodePolyfillPlugin()],
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
                        fallback: { "timers": require.resolve("timers-browserify") },
                    },
                    use: [{ loader: "ts-loader" }],
                },
            ],
        },
        output: {
            path: __dirname + "/dist",
            filename: "preload.js",
        },
        cache: {
            type: 'filesystem',
            buildDependencies: {
                config: [__filename]
            }
        },
        plugins: [new NodePolyfillPlugin()],
    },
    {
        mode: "production",
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
                        fallback: { "timers": require.resolve("timers-browserify") },
                    },
                    use: [{ loader: "ts-loader" }],
                },
            ],
        },
        output: {
            path: __dirname + "/dist",
            filename: "index.js",
        },
        cache: {
            type: 'filesystem',
            buildDependencies: {
                config: [__filename]
            }
        },
        plugins: [
            new HtmlWebpackPlugin({
                template: "./src/index.html",
            }),
            new NodePolyfillPlugin(),
        ],
    },
]
