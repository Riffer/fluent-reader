# Fluent Reader - Setup & Build Guide

## Prerequisites

Before building Fluent Reader, ensure you have the following installed:

### Required Software
- **Node.js**: v24.11.1 LTS (or higher)
  - Download from: https://nodejs.org/
  - Verify installation: `node --version` and `npm --version`
  - A `.nvmrc` file specifies v24.11.1 for nvm users
- **Git**: For version control
- **Python 3**: Required for some native modules (better-sqlite3)

### Recommended Versions
- **Node.js**: v24.11.1 LTS (April 2027 support)
- **npm**: v11.x (comes with Node 24)
- **Chocolatey**: (Windows) for easy package management

## Installation Steps

### 1. Clone the Repository
```bash
git clone https://github.com/yang991178/fluent-reader.git
cd fluent-reader
```

### 2. Install Dependencies
```bash
npm install
```

Note: Node 24 has built-in OpenSSL 3.x support, so legacy provider flags are typically not needed anymore.

### 3. Verify Installation
```bash
npm list electron
npm list typescript
```

## Building & Running

### Development Mode (Build + Run)
```bash
npm start
```

This runs both `npm run build` and `npm run electron` sequentially.

### Build Only
```bash
npm run build
```

### Run Only (after build)
```bash
npm run electron
```

### Format Code (Prettier)
```bash
npm run format
```

## Packaging

### Windows APPX Package (All Architectures)
```bash
npm run package-win
```

Creates APPX packages for x64, ia32, and arm64 architectures.

### Windows APPX Package (x64 Only - CI)
```bash
npm run package-win-ci-x64
```

### Legacy Build (for older Node versions)
For Node 18.x environments:
```bash
npm run package-win-ci-legacy
```
Note: Node 24.11.1 should not require this flag.

### macOS
```bash
npm run package-mac
```

### macOS App Store (MAS)
```bash
npm run package-mas
```

Requires code signing certificates.

### Linux
```bash
npm run package-linux
```

## Troubleshooting

### Node Version Compatibility
**Error**: `better-sqlite3 requires Node 20+`

**Solution**: Ensure you're using Node 24.11.1 LTS
```bash
node --version  # Should be v24.11.1 or higher
```

If using nvm (Windows nvm-windows):
```bash
nvm install 24.11.1
nvm use 24.11.1
```

### Node Modules Issues
If you encounter module conflicts, try:
```bash
rm -rf node_modules package-lock.json
npm install
```

### Electron Build Issues
- Clear the build cache: `rm -rf dist/`
- Clear node_modules: `rm -rf node_modules package-lock.json`
- Rebuild: `npm install` then `npm run build`

### Deprecated Configuration Warning
If you see warnings about `linux.desktop.StartupWMClass`, these are automatically handled in electron-builder 26.0.12+

### TypeScript Compilation Errors
Verify TypeScript version matches package.json (v5.9.3):
```bash
npx tsc --version
```

## Important Dependencies

### Key Versions (from package.json)
- **Electron**: ^39.2.3 (Chromium 132.x)
- **TypeScript**: ^5.9.3 (upgraded from 4.3.5)
- **React**: ^16.13.1
- **Webpack**: ^5.103.0
- **Electron-Builder**: ^26.0.12 (upgraded from 23.0.3 with RCE security fixes)
- **Electron-Store**: ^8.1.0 (compatible with React 16)
- **Article Extractor**: ^8.0.20 (for full content extraction)
- **better-sqlite3**: ^12.4.6 (for future SQLite3 migration)

### Build Tools
- **webpack**: Module bundler
- **ts-loader**: TypeScript loader for webpack
- **html-webpack-plugin**: HTML generation
- **copy-webpack-plugin**: File copying during build

## Development Workflow

1. Make code changes in `src/`
2. Run `npm run build` to compile TypeScript and bundle
3. Run `npm run electron` to launch the application
4. Test your changes
5. Use `npm run format` to format code with Prettier
6. Commit and push changes

## Environment Variables

### Windows Build (Node 24)
No special environment variables needed with Node 24.11.1 LTS.

For legacy Node 18 environments:
```bash
SET NODE_OPTIONS=--openssl-legacy-provider
```

## Additional Resources

- TypeScript Configuration: `tsconfig.json`, `tsconfig.main.json`, `tsconfig.renderer.json`
- Webpack Configuration: `webpack.config.js`
- Electron Configuration: `electron-builder.yml`, `electron-builder-mas.yml`

## License

Fluent Reader is licensed under the BSD-3-Clause License. See LICENSE file for details.
