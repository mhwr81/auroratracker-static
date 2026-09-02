# AuroraTracker Privacy Policy

**Last updated:** 2 September 2026

AuroraTracker ("we," "our," or "us") is committed to protecting your privacy. This Privacy Policy explains what information the AuroraTracker mobile application collects, how it is used, and who it is shared with.

By using AuroraTracker, you agree to the collection and use of information in accordance with this policy.

---

## The Short Version

**We operate no servers and hold no database about you.** AuroraTracker runs entirely on your device. There is no AuroraTracker account, no login, and no user profile. Anything the app remembers — your location, your settings, your Hunt Log — is stored in your device's private app storage and is removed when you uninstall.

However, the app is not isolated. To do its job it talks directly from your device to third-party services, and two categories of that traffic do carry information about you:

- **Your location is sent to weather providers** so the app can tell you whether clouds will spoil tonight's view.
- **Advertising services receive your device's advertising ID** so ads can be served in the free version.

Both are described in detail below.

---

## Information We Collect

### Location Data

- **What:** GPS coordinates (latitude and longitude), or coordinates you enter manually. From these we derive a city name, country name, and geomagnetic latitude.
- **Why:** To calculate aurora visibility, local viewing times, and cloud cover for your position.
- **Where it is stored:** On your device only, in the app's private storage, so the app does not have to re-acquire your position on every launch. We never receive it.
- **Where it is sent:** Your coordinates are transmitted to the weather providers listed under *Third-Party Services* below, in order to retrieve a cloud-cover forecast for your position. Your coordinates are also passed to your device's built-in geocoding service to convert them into a place name.
- **Control:** Location access is optional. You can deny it and enter coordinates manually, or use the app without location — most features still work. You can revoke the permission at any time in your device settings.

Note that the space weather data sources (NOAA, NASA and the others listed below) are fetched as fixed public files. **Your location is never sent to them.**

### Advertising Data (free version only)

- **What:** Your device's resettable advertising identifier, general device information, and coarse (approximate) location derived by the advertising service.
- **Why:** To display ads, which fund the free version of the app.
- **Who:** Google AdMob. See *Third-Party Services*.
- **Control:** Purchasing AuroraTracker Pro removes ads entirely. You can also reset or delete your advertising ID in your device's privacy settings. If you are in the EEA, the UK, or Switzerland, you will be asked for your advertising preferences and can change them at any time.

### Diagnostic and Crash Data

- **What:** Crash reports, including the error and stack trace, device model, operating system version, and a randomly generated installation identifier. If the app crashes, a short log of recent in-app events is included to help us understand what led to it.
- **Why:** To find and fix defects. This is the only way we learn that the app failed on a real device.
- **Who:** Firebase Crashlytics (Google). See *Third-Party Services*.
- **What it is not:** Crash reports are not linked to your identity, are not used for advertising, and are not used to build a profile of you.

### Notification Data

- **Device Token:** A Firebase Cloud Messaging token identifying your device as a recipient for storm alerts.
- **Notification Preferences:** Your alert thresholds and notification settings — stored on your device.
- **Alert History:** Recently received alerts, stored on your device for your reference.
- **Control:** You can disable notifications in the app or revoke the permission in device settings.

### Hunt Log Data (if you use the feature)

- **What:** Entries you create yourself — timestamp, location name and coordinates, the space weather conditions at that moment, your own notes, and any photos you attach.
- **Where it is stored:** Entirely on your device. Entry details are held in the app's private storage and photos are copied into the app's private documents directory.
- **Sharing:** Nothing leaves your device unless *you* explicitly tap Share, at which point you choose the recipient app yourself.

### Purchase Data

- **What:** Whether you hold an active AuroraTracker Pro entitlement.
- **How:** Purchases are handled entirely by Google Play Billing. **We never see or receive your payment card, billing address, or any financial information.** The app only asks Google Play whether a purchase exists.

### What We Do NOT Collect

- We do not use analytics and do not record which screens or features you use.
- We do not track you across other apps or websites.
- We have no user accounts, so we hold no names, email addresses, or passwords.
- We do not collect your contacts, calendar, microphone, or camera roll at large — the photo picker returns only the specific images you select.

---

## Legal Basis for Processing (EEA / UK Users)

| Purpose | Legal basis |
|---|---|
| Aurora forecasting and cloud-cover lookup using your location | Consent (the location permission you grant), withdrawable at any time |
| Sending storm alert notifications | Consent (the notification permission you grant) |
| Personalised advertising | Consent, collected through the in-app consent prompt |
| Non-personalised advertising | Legitimate interest in funding a free app |
| Crash and stability reporting | Legitimate interest in providing a working, secure application |
| Delivering a purchased Pro entitlement | Performance of a contract |

---

## Third-Party Services

### Services That Receive Information About You

| Service | What it receives | Purpose |
|---|---|---|
| **Open-Meteo** | Your latitude and longitude | Cloud cover and visibility forecast |
| **WeatherAPI.com** | Your latitude and longitude | Extended weather forecast |
| **Google AdMob** | Advertising ID, device info, approximate location | Serving ads in the free version |
| **Firebase Cloud Messaging** (Google) | Device push token | Delivering storm alerts |
| **Firebase Crashlytics** (Google) | Crash reports, device model, OS version, install ID | Diagnosing crashes |
| **Google Play Billing** | Purchase transaction | Processing Pro purchases |
| **Google Maps** (Pro map view) | Map viewport and location | Rendering the interactive aurora map |
| **OpenStreetMap tile servers** | Map viewport | Rendering map tiles in the free map view |
| **Your device's geocoding service** | Your coordinates | Converting coordinates to a place name |

Each of these providers handles the data it receives under its own privacy policy. Because they are global services, information may be processed in countries outside your own, including the United States.

### Public Data Sources (No Personal Data Sent)

The following are fetched as fixed public files. They receive no information about you beyond the ordinary network request your device must make to reach them:

- **NOAA Space Weather Prediction Center** — space weather measurements and forecasts
- **NASA** (CCMC, ISWA, SDO/AIA) — solar imagery and CME modelling
- **SIDC / Royal Observatory of Belgium** — sunspot and solar event data
- **University of Reading Space Weather Forecast Lab** — solar wind modelling
- **YouTube** — embedded educational video content

---

## Data Retention

| Data | Retained |
|---|---|
| Location, settings, alert history, Hunt Log | On your device until you delete the entry, clear app data, or uninstall |
| Cached space weather and weather responses | Minutes to hours, then automatically expired |
| Crash reports | Retained by Firebase Crashlytics for up to 90 days |
| Advertising identifiers | Governed by Google's advertising data policies |

Because we operate no servers, uninstalling the app removes everything AuroraTracker stored about you on your device.

---

## Your Rights

You have the right to access, correct, delete, export, and restrict the processing of your personal data, and to object to processing based on legitimate interests.

In practice, most of these are immediate and in your own hands:

- **Access and portability:** Your data lives on your device. Hunt Log entries can be exported and shared from within the app.
- **Deletion:** Delete individual Hunt Log entries in the app, or clear all app data / uninstall to remove everything.
- **Withdraw consent:** Revoke location or notification permissions in device settings at any time. Ad preferences can be changed through the in-app consent prompt.
- **Object to ads:** Purchase Pro, or reset your advertising ID.

For anything you cannot do yourself — in particular a request to delete crash reports associated with your installation — contact us at **privacy@auroratracker.app**. We will respond within 30 days, as required by the GDPR, and usually much sooner.

**If you are in the EEA or UK**, you also have the right to lodge a complaint with your local data protection supervisory authority.

---

## Data Security

- **Encryption in transit:** All network requests use HTTPS/TLS.
- **On-device storage:** App data is held in private application storage, protected by your device's own sandboxing and encryption.
- **Minimal collection:** We request only what the forecasting features actually need.
- **No central store:** Because we operate no servers and hold no user database, there is no central repository of user data to breach.

---

## Children's Privacy

AuroraTracker is a general-audience app for people interested in aurora viewing and space weather. It is not directed at children, and we do not knowingly collect personal information from children under 13 (or under the applicable age of digital consent in your country).

If you believe a child has provided us with personal information, contact **privacy@auroratracker.app** and we will take steps to remove it.

---

## Device Permissions Explained

### Location (ACCESS_FINE_LOCATION, ACCESS_COARSE_LOCATION)
- **Purpose:** Aurora visibility calculations and local cloud-cover forecasts.
- **Scope:** Foreground only. The app does not request background location access.
- **Control:** Optional — coordinates can be entered manually instead.

### Notifications (POST_NOTIFICATIONS)
- **Purpose:** Required by Android 13+ to display geomagnetic storm alerts.
- **Usage:** Aurora and space weather alerts only. No marketing notifications.

### Boot Completion (RECEIVE_BOOT_COMPLETED)
- **Purpose:** Re-registers alert monitoring after your device restarts.
- **Privacy:** No personal information is accessed during boot.

### Exact Alarms (SCHEDULE_EXACT_ALARM)
- **Purpose:** Schedules timely alert checks so storm notifications are not delayed.

### Foreground Service (FOREGROUND_SERVICE)
- **Purpose:** Allows background space weather checks to complete reliably.

### Wake Lock (WAKE_LOCK)
- **Purpose:** Keeps the screen awake while you are actively watching live aurora data, and allows background checks to finish.

### Network State (ACCESS_NETWORK_STATE)
- **Purpose:** Detects whether you are online, so the app can serve cached data instead of failing.

### Storage (WRITE_EXTERNAL_STORAGE)
- **Purpose:** Saving Hunt Log photos and exported entries on older Android versions.

---

## Advertising and Consent

The free version of AuroraTracker displays ads supplied by Google AdMob.

If you are located in the European Economic Area, the United Kingdom, or Switzerland, you will be shown a consent prompt before personalised advertising is enabled. You may decline personalised ads and still use the app; you will see non-personalised ads instead. You can revisit and change this choice at any time from the app's settings.

Google's use of advertising data is described in [Google's Privacy & Terms](https://policies.google.com/technologies/partner-sites).

**AuroraTracker Pro removes all advertising**, and with it all advertising-related data collection.

---

## California Residents (CCPA/CPRA)

We do not sell personal information, and we do not share personal information for cross-context behavioural advertising in exchange for money. Serving personalised ads through AdMob may nonetheless constitute "sharing" under the CPRA. To opt out, decline personalised ads in the consent prompt, reset your advertising ID in device settings, or purchase Pro.

California residents have the right to know, delete, and correct personal information, and not to be discriminated against for exercising those rights. Contact **privacy@auroratracker.app**.

---

## Changes to This Policy

We may update this Privacy Policy to reflect changes in our practices, new features, or legal requirements. Changes will be posted with an updated "Last updated" date. For changes that materially affect your privacy, we will provide additional notice in the app.

Continued use of AuroraTracker after changes take effect constitutes acceptance of the updated policy.

---

## Contact

**Privacy enquiries and data requests:** privacy@auroratracker.app

**General enquiries:** matt@auroratracker.app
