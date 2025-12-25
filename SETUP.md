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

### Crash Dump Analysis (Windows)

When the Electron app crashes, crash dumps are automatically saved to:
```
%APPDATA%\Electron\Crashpad\reports\
```

#### Installing the Debugger

The Windows Debugger (WinDbg/cdb) is needed to analyze crash dumps. Install it via:

**Option 1: Microsoft Store (Recommended)**
- Search for "WinDbg Preview" in Microsoft Store
- Install it - this includes `cdbX64.exe` in the WindowsApps folder

**Option 2: Windows SDK**
- Download Windows SDK from: https://developer.microsoft.com/en-us/windows/downloads/windows-sdk/
- During installation, select "Debugging Tools for Windows"

After installation, verify `cdbX64` is available:
```powershell
where.exe cdbX64
# Should return: C:\Users\<USER>\AppData\Local\Microsoft\WindowsApps\cdbX64.exe
```

#### Finding the Latest Crash Dump

```powershell
$latestDump = Get-ChildItem -Path "$env:APPDATA\Electron\Crashpad\reports" -Filter "*.dmp" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Write-Host "Latest crash: $($latestDump.Name) - $($latestDump.LastWriteTime)"
```

#### Basic Crash Analysis

Run the debugger with automatic analysis:
```powershell
cdbX64 -z "<path-to-dump>.dmp" -c "!analyze -v; .ecxr; kb; q"
```

**Key commands explained:**
- `!analyze -v` - Verbose automatic analysis (shows crash type, faulting module)
- `.ecxr` - Switch to exception context (shows CPU registers at crash time)
- `kb` - Display stack backtrace with parameters
- `q` - Quit debugger

#### Example: Full Analysis Session

```powershell
# Find and analyze the latest crash
$latestDump = Get-ChildItem -Path "$env:APPDATA\Electron\Crashpad\reports" -Filter "*.dmp" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
cdbX64 -z $latestDump.FullName -c ".ecxr; !analyze -v; kb 20; q" 2>&1 | Select-Object -Last 80
```

#### Interpreting Results

**Common crash indicators:**
- `AV.Type: Read` + `AV.Dereference: NullPtr` = Null pointer dereference
- `rax=0000000000000000` in registers = Trying to access address 0x0
- `electron!v8::...` in stack = Crash in JavaScript engine (V8)

**Example crash output:**
```
KEY_VALUES_STRING: 1
    Key  : AV.Dereference
    Value: NullPtr
    Key  : AV.Type
    Value: Read
    Key  : Failure.Bucket
    Value: INVALID_POINTER_READ_c0000005_electron.exe!Unknown
```

This indicates JavaScript code tried to access a property on `null` or `undefined`.

#### Preventing Common Crashes

1. **Always check if objects exist before calling methods:**
   ```typescript
   // Bad - crashes if contentView is null
   window.contentView.navigate(url)
   
   // Good - safe access
   if (window.contentView) {
       window.contentView.navigate(url)
   }
   ```

2. **Don't call Device Emulation on empty WebContents:**
   ```typescript
   // Check pageLoaded before device emulation calls
   if (this.pageLoaded) {
       this.contentView.webContents.disableDeviceEmulation()
   }
   ```

3. **Send IPC messages only after page is loaded:**
   ```typescript
   // Preload script must be running before it can receive messages
   await window.contentView.navigate(url)
   // Now preload is loaded, safe to send settings
   window.contentView.send('set-zoom-level', level)
   ```

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
