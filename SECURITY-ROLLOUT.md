# Security rollout

The API used to accept every request anonymously. It now requires a Firebase ID
token. **Deploy order matters** — the backend will reject the currently-live
clients unless you follow the sequence below.

## ⚠️ Rotate these first

`.env` was committed to this repository and is recoverable from git history.
Every value in it must be treated as compromised, whether or not the repo is
private. Rotate at the provider — untracking the file does not undo exposure.

| Secret | Where to rotate |
| --- | --- |
| `VITE_private_key` + service-account fields | Firebase Console → Project settings → Service accounts → generate a new private key, then delete the old one |
| `USERNAME_DB` / `PASSWORD_DB` | MongoDB Atlas → Database Access → edit user password |
| `SP_USERNAME` / `SP_PASSWORD` | ShurjoPay merchant panel |
| `APP_CERTIFICATE` | Agora Console → project → regenerate certificate |
| `VITE_SUPABASE_ANON_KEY` | Supabase → Project settings → API |
| `AUTHORIZATION_TOKEN` | Whiteboard provider dashboard |

The Firebase service-account key is the urgent one: it grants admin access to
the whole Firebase project regardless of any change in this codebase.

`.env` is now untracked, but it still exists in history. If this repo is public,
or ever was, rewrite history (`git filter-repo --path .env --invert-paths`) and
force-push after rotating. Rotation alone is enough for a private repo.

## Deploy sequence

Render deploys on push, so a backend push is a production deploy.

1. **Set `AUTH_ENFORCE=false` in the Render dashboard before deploying.**
   Requests are still allowed through, but every one that would have been
   rejected is logged as `[auth] would reject …`.
2. **Deploy the web clients first** — `app.poperl.com` and `PoperLWeb`. They
   start sending `Authorization: Bearer <id token>`, which the old backend
   simply ignores, so this is safe to ship on its own.
3. **Deploy the backend.**
4. **Watch the logs.** `[auth] would reject` lines tell you exactly which
   caller and route is still anonymous. Expect a burst from old app builds
   hitting `/createCustomToken`.
5. **Set `AUTH_ENFORCE=true`** (or remove it — true is the default) once the
   warnings stop.
6. **Set `ALLOWED_ORIGINS=https://app.poperl.com,<admin origin>`** to close CORS.
   Unset means every origin is accepted.

## Native app builds

`/createCustomToken` now reads the uid from a verified ID token instead of the
request body. Builds already installed on phones send a bare uid and will fail
to sign in.

Ship the updated `PoperL` build, then leave `ALLOW_LEGACY_UID_TOKEN` unset.

If you must support old builds during the transition, set
`ALLOW_LEGACY_UID_TOKEN=true` — but understand that while it is on, anyone who
knows a uid can obtain a session for that account. Treat it as a countdown, not
a setting.

## What is enforced

- Every route requires a verified ID token except: `/ipn` (ShurjoPay callback),
  `/userProfile/:uid` (public teacher page), `/createCustomToken` (verifies its
  own token), `/newStudent`, `/newTeacher`.
- `/api/admin/*`, `/paySalary`, `/rejectSalary`, `/admin-add-subscription`,
  `/deleteUser`, `/disableTeacher`, `/enableTeacher`, and writes to
  `/credit-price` require a uid present in the `owner` collection.
- Socket connections must present a token in the handshake. Identity comes from
  that token; client-supplied uids in payloads are ignored. `joinChatRoom`
  verifies the caller is actually a participant.
- `/api/messages/credit-point` and `/api/teachers/withdraw` reject a uid that is
  not the caller's.

Run `node middleware/auth.test.js` to check the routing table after edits.

## Known gaps

- `/api/messages/credit-point` still lets a teacher award points to *their own*
  account. Closing it properly means deriving credit and points server-side
  during message send rather than trusting a client call.
- Per-resource ownership is not checked on most routes: any signed-in user can
  still act on room/quiz/course records they do not belong to. Authentication is
  now solid; per-object authorization is the next pass.
