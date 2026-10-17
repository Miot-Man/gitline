# Gitline

A desktop Git client built with Electron, React and TypeScript. It shells out to your installed `git`, so your existing config, credentials and SSH keys just work.

## Run

```sh
npm install
npm run dev     # hot-reloading dev mode
npm start       # production build + launch
```

## Layout

- `electron/git.cjs` – every git operation (log, status, diff, stage, commit, merge, rebase, push, …)
- `electron/main.cjs` – window, menus, IPC, file watching, recent repos
- `electron/preload.cjs` – the `window.api` bridge
- `src/lib/graph.ts` – commit graph lane layout
- `src/components/` – UI (`RepoView` orchestrates the toolbar, sidebar, graph, diff and right panel)
