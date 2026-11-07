# Fork CI policy

This fork pins reusable upstream workflows to immutable commits. A moving
branch such as `master` can change policy and tool requirements without any
change in this repository, which makes the fork's required checks
non-reproducible.

## Updating an upstream workflow pin

1. Open a pull request that changes only the pin and any compatibility changes
   required by that exact upstream revision.
2. Record the previous and proposed upstream commits and link the upstream
   diff or release notes.
3. Run the fork's required checks against the proposed pin. Do not weaken,
   skip, or rename a required check to obtain a pass.
4. Obtain the normal CODEOWNERS review for `.github/**` and merge through the
   protected branch path.
5. If the update regresses the fork, revert to the previous immutable commit
   and retain the failed run as evidence for the next compatibility change.

The current pin corresponds to the upstream workflow revision selected for the
fork's existing baseline. It does not certify application deployment or live
Paperclip acceptance; those remain separate release gates.
