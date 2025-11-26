# Fluent Reader - Setup & Build Guide

## Prerequisites

Before building Fluent Reader, ensure you have the following installed:

### Required Software
- **Node.js**: v16.x or v18.x (LTS recommended)
  - Download from: https://nodejs.org/
  - Verify installation: `node --version` and `npm --version`
- **Git**: For version control
- **Python 3**: Required for some native modules

### Recommended Versions
- **Node.js**: v18.x LTS
- **npm**: v9.x or higher (comes with Node.js)

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

If you encounter OpenSSL-related errors, you may need to use the legacy OpenSSL provider:
```bash
SET NODE_OPTIONS=--openssl-legacy-provider
npm install
```

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

### Legacy Build (OpenSSL)
If you encounter OpenSSL errors during packaging:
```bash
npm run package-win-ci-legacy
```

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

### OpenSSL Legacy Provider Error
**Error**: `digital envelope routines::unsupported`

**Solution**: Use the legacy OpenSSL provider
```bash
SET NODE_OPTIONS=--openssl-legacy-provider
npm run build
```

Or create a `.npmrc` file:
```
openssl-legacy-provider=true
```

### Node Modules Issues
If you encounter module conflicts, try:
```bash
rm -rf node_modules package-lock.json
npm install
```

### Electron Build Issues
- Clear the build cache: `rm -rf dist/`
- Rebuild: `npm run build`

### TypeScript Compilation Errors
Verify TypeScript version matches package.json (v4.3.5):
```bash
npx tsc --version
```

## Important Dependencies

### Key Versions (from package.json)
- **Electron**: ^39.2.1 (Chromium 132.x)
- **TypeScript**: 4.3.5
- **React**: ^16.13.1
- **Webpack**: ^5.89.0
- **Electron-Builder**: ^23.0.3
- **Article Extractor**: ^8.0.20 (for full content extraction)

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

### Windows Build
```bash
SET NODE_OPTIONS=--openssl-legacy-provider
```

Use this before building if you encounter OpenSSL errors.

## Additional Resources

- TypeScript Configuration: `tsconfig.json`, `tsconfig.main.json`, `tsconfig.renderer.json`
- Webpack Configuration: `webpack.config.js`
- Electron Configuration: `electron-builder.yml`, `electron-builder-mas.yml`

## License

Fluent Reader is licensed under the BSD-3-Clause License. See LICENSE file for details.
