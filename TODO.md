# TODO: sequential question queue

- [ ] Create branch feat/sequential-queue
- [ ] Update service.ts: replace pendingQueue with sendQueue + activeRequestId
- [ ] Update service.ts: add processQueue() dispatcher
- [ ] Update service.ts: POST /request defers Telegram send, calls processQueue()
- [ ] Update service.ts: pollLoop resolves activeRequestId, calls processQueue()
- [ ] Update service.ts: GET /response/:id handles failReason (502)
- [ ] Update service.ts: GET /health shows queued/active
- [ ] npm run build — verify passes
- [ ] git diff --staged review
- [ ] git commit
- [ ] git push -u origin feat/sequential-queue
- [ ] npm version patch
- [ ] npm publish --access public
- [ ] gh pr create
- [ ] gh pr merge --squash --auto
