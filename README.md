# BlockForge Launcher

BlockForge is a custom Minecraft Java launcher focused on a clean profile workflow, Microsoft login, modpack imports, and Modrinth/CurseForge content management.

## Current Features

- Windows portable launcher build
- Browser-based Microsoft Java login
- Offline/dev Java accounts
- Java profile creation and imports
- Fabric, Quilt, Forge, NeoForge, Vanilla, and snapshot launch paths where upstream metadata is available
- Modrinth and CurseForge browsing/install support
- Modpack import/install support
- Installed mod/resource pack/shader management
- Running instance tracking and kill controls
- GitHub Pages website in `docs/`

## Development

Install dependencies:

```powershell
npm install
```

Build a Windows portable executable:

```powershell
npx electron-builder --win portable --config.directories.output=release-fast-local
```

## Website

The GitHub Pages site lives in `docs/`.

In GitHub, go to `Settings > Pages`, choose `Deploy from a branch`, then select the `docs` folder on your main branch.

## Releases

Do not commit `release-fast*` folders. Upload the generated `.exe` to GitHub Releases instead.

## Disclaimer

BlockForge is not affiliated with Mojang, Microsoft, Prism Launcher, CurseForge, or Modrinth.
