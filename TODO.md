# TODO: add tests

- [x] Create branch feat/add-tests
- [ ] Update package.json: add jest, ts-jest, @types/jest; add test script + jest config
- [ ] Refactor src/service.ts: export tgSend*, tgGetUpdates, processQueue, _state, _resetState, httpHandler; guard startup
- [ ] Refactor src/mcp.ts: export postRequest, pollResponse, requestHumanInput; guard MCP server startup
- [ ] Write src/__tests__/service.test.ts
- [ ] Write src/__tests__/mcp.test.ts
- [ ] npm install && npm test — all green
- [ ] npm run build — passes
- [ ] git add, diff --staged, commit, push, PR
