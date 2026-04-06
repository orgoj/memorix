# Memorix Release Merge

Upgrade na nový upstream tag s customizacemi.

## Trigger

- `release merge`
- `merge to tag`
- `sync to release`
- `nová verze merge`
- `upgrade tag`

## Koncept

```
orgoj-v1.0.5 (stará)    →  orgoj-v1.0.6 (nová)
     ↓                            ↓
customizace            ←    kopie customizací
```

**STARÁ `orgoj` branch se NEPOUŽÍVÁ!** Zdroj je vždy `orgoj-PŘEDCHOZÍ-TAG`.

## Workflow

### 1. Najdi tagy

```bash
LATEST_TAG=$(git tag --sort=-version:refname | head -1)
PREV_BRANCH=$(git branch --list 'orgoj-v*' | sort -V | tail -1 | tr -d ' *')
NEW_BRANCH="orgoj-${LATEST_TAG}"
```

### 2. Vytvoř worktree z nového tagu

```bash
WORKTREE_PATH=".claude/worktrees/${NEW_BRANCH}"
git worktree add "$WORKTREE_PATH" -b "$NEW_BRANCH}" "$LATEST_TAG"
```

### 3. Zjisti co chybí

Porovnej NOVÝ tag s PŘEDCHOZÍ `orgoj-*` branch:

```bash
git diff "$LATEST_TAG" "$PREV_BRANCH" --stat
```

**Typicky chybí:**
- `.dippy` - konfig
- `.gitignore` - beads, omc
- `src/cli/index.ts` - čeština
- `src/hooks/pattern-detector.ts` - české patterny
- `src/memory/observations.ts` - mutex
- `src/cli/commands/serve-http.ts` - session 8h
- `src/server.ts` - skip reindex

### 4. Zkopíruj customizace VE WORKTREE

```bash
cd "$WORKTREE_PATH"
git show "$PREV_BRANCH":.dippy > .dippy
git show "$PREV_BRANCH":.gitignore > .gitignore
git show "$PREV_BRANCH":src/cli/index.ts > src/cli/index.ts
# ... další soubory
```

### 5. Vytvoř čisté commity VE WORKTREE

```bash
# Commit 1: Config
git add .dippy .gitignore
git commit -m "chore: add dippy config and update gitignore"

# Commit 2: Čeština
git add src/cli/index.ts src/hooks/pattern-detector.ts src/search/intent-detector.ts
git commit -m "feat(cs): add Czech language support"

# Commit 3: Mutex
git add src/memory/observations.ts
git commit -m "fix: add mutex to prevent concurrent reindex CPU waste"

# Commit 4: Session + reindex
git add src/cli/commands/serve-http.ts src/server.ts
git commit -m "fix: increase session timeout to 8h and skip full reindex on HTTP"
```

### 6. Build a test VE WORKTREE

```bash
(cd "$WORKTREE_PATH" && npm install && npm run build)
```

### 7. Push a smaž worktree

```bash
(cd "$WORKTREE_PATH" && git push -u origin "$NEW_BRANCH}")
git worktree remove --force "$WORKTREE_PATH"
```

### 8. Přepni repo na novou branch

```bash
git checkout "$NEW_BRANCH}"
```

### 9. Nainstaluj globálně

```bash
npm link
memorix --version
```

## Checklist

- [ ] Najdi LATEST_TAG a PREV_BRANCH
- [ ] Worktree z nového tagu
- [ ] Porovnej co chybí (diff)
- [ ] Zkopíruj custom soubory z PREV_BRANCH
- [ ] Čisté commity
- [ ] Build OK
- [ ] Push
- [ ] Worktree smazán
- [ ] Repo na nové branchi
- [ ] `npm link`

## Soubory k migraci

Vždy zkontroluj diff, typicky:
- `.dippy`
- `.gitignore`
- `src/cli/index.ts`
- `src/hooks/pattern-detector.ts`
- `src/search/intent-detector.ts`
- `src/memory/observations.ts`
- `src/cli/commands/serve-http.ts`
- `src/server.ts`

## Důležité

- **Zdroj = předchozí `orgoj-TAG` branch, NE stará `orgoj`**
- Nová branch se stává produkční
- Příští upgrade: z aktuální `orgoj-TAG` do nové
