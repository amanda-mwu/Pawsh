# Pawsh groomer app

The iOS and Android app for the salon floor. It talks to the same Fastify backend as the web app
and shares its domain rules through `@pawsh/domain`.

Scope is groomer operations: Today, Calendar, appointment detail with the check-in → start
service → complete sequence and operational notes, and read-only client and pet records. Salon
administration stays on a desk.

## This is not an npm workspace member

The repository root declares `"workspaces": ["packages/*"]` and deliberately excludes `apps/*`.
Hoisting Expo into the root dependency graph would add roughly a thousand packages to every
`npm ci` on the server CI runners, which have no reason to install a React Native toolchain.

Consequences worth knowing:

- This directory has its own `package.json` **and its own `package-lock.json`**. Install from here.
- `@pawsh/domain` is a `file:` dependency, which npm links rather than copies. The shared package
  must be **built** before the app can resolve it:

  ```sh
  npm --prefix ../.. run build:packages
  ```

  `packages/domain/dist` is git-ignored, so this is the first thing to run in a fresh clone.
- `metro.config.js` watches `packages/domain` and pins module resolution to this app's own
  `node_modules`, so the bundle never picks up a second copy of React from the root tree.

## Setup

```sh
npm --prefix ../.. run build:packages   # build @pawsh/domain into dist/
npm install                             # from apps/mobile
```

## Running it on a device

Pawsh mobile runs as an **installed Pawsh development build** — a native app compiled from this
source and installed on the device or emulator. It is not run through a general-purpose sandbox
client, so the app can carry native modules this project actually needs rather than only those a
shared client happens to bundle.

There are two steps, and the first is only repeated when native dependencies change:

```sh
npm run android      # compiles and installs the development build, then starts Metro
npm start            # subsequent runs: just start Metro; the installed app connects to it
```

`npm start` runs Metro for the development build. Installing the app is `npm run android` (or
`npm run ios` on macOS); after that, day-to-day work only needs Metro.

### Android prerequisites

`npm run android` compiles native code, so it needs a local Android toolchain:

- **Android Studio**, which supplies the Android SDK, platform-tools (`adb`), and an emulator
- **JDK 17**, which Android Studio can install
- `ANDROID_HOME` set to the SDK location, with `platform-tools` on `PATH`

Without these, `npm run android` fails at the Gradle step. Typecheck, tests, and the bundle
checks below all run fine without any of it.

### iOS

iOS development builds require **macOS with Xcode**. Windows cannot compile an iOS app or run the
iOS Simulator, and no configuration changes that. `npm run ios` is there for macOS machines.

## Pointing the app at a server

The API base URL comes from `EXPO_PUBLIC_PAWSH_API_URL`, read in `app.config.ts` and exposed
through `expo-constants` as `extra.apiUrl`. It is never hardcoded at a call site.

| Where you are running | Value |
| --- | --- |
| iOS simulator on the dev machine | `http://localhost:3000` (the default) |
| Android emulator | `http://10.0.2.2:3000` |
| **A physical device** | `http://<your-LAN-IP>:3000` |

A physical device cannot reach the development machine's loopback address, and the failure looks
exactly like a dead server. Find your LAN address (`ipconfig` on Windows, `ifconfig` on macOS),
confirm the phone is on the same network, and start the app with it:

```sh
# the address below is an example; substitute your own
EXPO_PUBLIC_PAWSH_API_URL=http://192.0.2.10:3000 npm start
```

The server binds `HOST`/`PORT` from the repository's `.env`; it must be listening on `0.0.0.0`
rather than `127.0.0.1` for a phone to reach it.

**No secrets belong in `app.config.ts`.** Everything under `extra` ships inside the JavaScript
bundle and is readable by anyone holding the app.

## How the session works

- `POST /api/auth/login` is sent with `x-pawsh-client: native`, which makes the server return a
  bearer token instead of setting a cookie. Only a client that asks at the moment it
  authenticates gets one, so a cookie can never be traded for a token later.
- The token is stored with `expo-secure-store` — the iOS Keychain and the Android Keystore-backed
  store — and never in AsyncStorage, which is an unencrypted file that rides along in device
  backups.
- Every request sends it as `Authorization: Bearer …`. It never appears in a URL or a query
  parameter.
- Sessions last 14 days with no refresh and no sliding expiry, so a `401` is terminal: the app
  clears the token and returns to sign-in.
- Signing out clears local state first and unconditionally, then revokes server-side. A failed
  revoke must not leave the app holding a credential it has already said is gone.

## Permissions

`can()` from `@pawsh/domain` decides what is rendered. A missing permission **removes** a control
rather than disabling it, matching the web app, which only inserts a button when its check passes.

This is UX. The server checks every one of these again, and that check is the one that authorizes
anything.

## Offline behaviour

There is no sync engine.

- **Reads** are cached and stay visible behind an offline banner. A groomer with a nine-hour-old
  schedule can still work; one staring at a spinner cannot.
- **Notes are queued.** The text is written to the device queue *before* the network is touched,
  renders immediately in its "not sent" treatment, retries automatically on reconnect, and can
  always be copied out. Queue entries survive the app being killed.
- **Status changes are never queued.** Check in, start service and complete advance a state
  machine the server owns and are ordered against what other staff are doing. Offline, the button
  is disabled with its label unchanged and a caption saying why. The reasoning is in
  `src/features/appointments/transition.ts`.

## Push notifications

Not wired, on purpose. The backend has no device-token table and no endpoint to register one, so
a push token acquired today would have nowhere to go. `src/notifications/index.ts` holds the
integration boundary and documents exactly what the backend needs to add and where registration
would be called from.

## Commands

```sh
npm start                # Metro, for an already-installed development build
npm run android          # compile and install the Android development build (needs the SDK)
npm run ios              # the same for iOS (macOS only)
npm run prebuild         # regenerate the native projects after a native dependency change
npm run typecheck        # tsc --noEmit
npm test                 # jest, from this directory only
npm run export:ios       # bundle for iOS — proves every module resolves
npm run export:android   # bundle for Android
```

`npx eslint .` is run from the repository root, which lints `apps/` along with everything else.

The root vitest `unit` project excludes `apps/**`; these tests run under jest with native module
mocks and would fail under vitest in ways that look like product bugs.

## Not in this release

Photo capture and upload, checkout and payment capture, push delivery, customer messaging, and
every configuration or administration screen. They are **absent, not stubbed** — a control that
opens "coming soon" costs trust every time it is tapped.
