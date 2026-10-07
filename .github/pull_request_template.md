## Summary

<!-- What changed and why, in a few lines. -->

## Checks

- [ ] `bash tools/ci/luau-check.sh` passes locally (Luau changes)
- [ ] `node tools/check-module-size.mjs` passes
- [ ] Studio checklist items in `game/README.md` touched by this change were run by hand (say which)
- [ ] I read every line of this diff and can explain it

## Save data

- [ ] This touches save data (Template, Migrations, StoreSelector)
  - [ ] A renamed, moved or retyped field bumped `SchemaVersion` and added a migration with a spec
