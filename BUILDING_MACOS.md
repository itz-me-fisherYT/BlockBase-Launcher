# Building BlockBaseMC for macOS

macOS packaging must be run on a Mac. From this project folder:

```sh
npm install
npm run electron:pack:mac
```

That command creates the `.icns` icon from `curseforge-assets/blockforge.iconset`, then builds:

- `release-mac/*.dmg`
- `release-mac/*.zip`

The config targets both Intel (`x64`) and Apple Silicon (`arm64`).

Notes:

- Java Edition launcher features are intended to work on macOS.
- Bedrock support has been removed from this build, so macOS/Linux planning now focuses on the Java launcher path.
- Unsigned local macOS builds may need to be opened from Finder with right click > Open, or signed/notarized for normal distribution.
