# Chat comparison fixtures

These two small journals are synthetic requirement examples. They are not presented as a captured
0.169 session. The record families come from the existing committed journal tests and the Codex
0.163 rollout fixtures; the real 0.169 capture is kept separately once available.

The two journals carry the same user request, Markdown, shell output, one-file edit, error, and
visible reasoning text. The reference is the task-4 brief and the owner screenshot.
The timestamps and paths are deliberately invented and contain no personal data.

The shell output envelope states its exit code explicitly. The patch itself supplies the path and
removed/added lines, so an edit card may use those facts without inventing data. A parser must not
infer an error from arbitrary output text when no status is present.

The input_image output-list shape was independently observed by the parent in a real Codex 0.169
session before implementation. The PNG bytes are committed public/badge-96x96.png, not owner data.
