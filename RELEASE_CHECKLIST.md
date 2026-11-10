# Beta release checklist

This is a GitHub beta preparation, not a Chrome Web Store approval or listing.
See `VALIDATION.md` for checks performed on this snapshot.

## Before the first public release

- Create the public repository under the connected account, with a fresh history.
  Import only this reviewed source directory. Never push the private development
  repository, its branches/tags, backups or parent folder.
- Confirm the publisher controls the rights to the included source and original
  application icon. No automated scanner can establish legal ownership.
- Enable GitHub private vulnerability reporting and appropriate repository security
  features. Use a public-safe commit identity; inspect commit metadata before push.
- Run all tests, release checks and a current local secret scanner. Inspect both
  source and extension archive inventories and verify their checksums.
- In a separate browser profile, test installation, one bounded follow-up, queue
  delivery, Pause/Stop, one heartbeat, input-request handling and a guarded
  conversation rollover. Test optional services with disposable data when needed.
- Record the browser version and actual results. Automated DOM mocks and offline
  dashboard checks do not establish live ChatGPT compatibility.
- Publish as a **prerelease**, with the extension ZIP, source ZIP and SHA256SUMS.
  Point users to the privacy notice and limitations before installation.

## Known beta limitations

- ChatGPT DOM and English control/notice wording can change.
- No exact token meter, shared-quota forecast or total spending cap is implemented.
  Review the live product's usage limits. Pause on service/quota notices.
- IDLE can create a 60-minute heartbeat; limits reset per cycle. Review schedules.
- Chrome must remain available. Computer sleep and browser alarm delays affect timing.
- Encrypted settings export does not include schedules, queues, history or server
  connection records. A separate unpacked install may have a different identity.
- The default schedule timezone is America/Chicago; users should set their own.
- The lab's flame logo is linked in branding documentation but is not bundled.

## Later Chrome Web Store submission

Prepare actual extension screenshots, a public privacy-policy URL, accurate
permission/data disclosures and developer-account details. Recheck current store
policies and applicable platform terms against the final behavior. No store
submission, account registration or compliance approval is represented by this beta.
