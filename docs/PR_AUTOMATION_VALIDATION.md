# PR automation validation

This documentation-only change exercises the repository’s independent PR review in review-only mode. It does not change console, player, USB, or runtime behavior.

The API key is stored in the codex-review environment, restricted to the main branch. The trusted main-branch workflow inspects PR changes as data; it does not run candidate scripts with the key. Automatic acceptance remains disabled during the initial smoke test.

Controller regressions cover stale head/base evidence, failed checks, findings, unresolved discussions, and stacked branch cleanup. A successful Actions run is also required before enabling automatic acceptance.

Review deduplication is keyed by both head and base SHA. Queued automatic events and repeated manual dispatches reuse the verified result; changing either SHA requires a fresh independent review.
