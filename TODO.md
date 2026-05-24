# TODO: rename meetbag → meatbag

- [ ] Create branch fix/rename-meatbag
- [ ] Fix package.json (name, bin key)
- [ ] Fix src/index.ts (env vars, log strings, server name, comments)
- [ ] npm install
- [ ] npm run build — verify dist/ exists
- [ ] git diff --staged review
- [ ] git commit
- [ ] git push -u origin fix/rename-meatbag
- [ ] npm publish --access public
- [ ] npm deprecate @gonzih/meetbag-mcp@1.0.0
- [ ] gh pr create
- [ ] gh pr merge --squash --auto
