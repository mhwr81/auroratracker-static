
AuroraTracker ("we," "our," or "us") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, and safeguard your information when you use our aurora forecasting mobile application.

By using AuroraTracker, you agree to the collection and use of information in accordance with this policy.

---

## Information We Collect

### Location Data
- **GPS Coordinates:** We request your location to provide localized aurora forecasts
- **Purpose:** To calculate aurora visibility for your specific location and timezone
- **Storage:** Location data is processed in real-time and not permanently stored
- **Control:** You can manually enter coordinates if you prefer not to use GPS

### Notification Data
- **Device Token:** Required to send geomagnetic storm alerts to your device
- **Notification Preferences:** Your alert thresholds and notification settings
- **Alert History:** Local storage of received storm notifications for your reference
- **Purpose:** To notify you when geomagnetic storms reach your selected threshold
- **Control:** You can disable notifications anytime in app settings

### Usage Data
- **Device Information:** Basic device type for responsive design optimization
- **App Performance:** Crash logs and performance metrics for improvement
- **Feature Usage:** Which screens and features are used most
- **No Personal Tracking:** We do not track individual user behavior patterns

---

## How We Use Your Information

1. **Aurora Forecasting:** Location data calculates personalized aurora visibility predictions
2. **Weather Integration:** Location provides local cloud cover and viewing conditions
3. **Storm Notifications:** Device permissions enable timely geomagnetic storm alerts
4. **Notification Management:** Device boot permission ensures alerts work after device restart
5. **User Experience:** Vibration and sound permissions provide customizable alert feedback
6. **App Optimization:** Usage data improves app performance and user experience
7. **Data Caching:** Temporary data storage to reduce API calls and improve load times

---

## Data Sharing and Third Parties

### Data Sources We Use
- **NOAA Space Weather Prediction Center:** Public space weather data
- **Solar Dynamics Observatory (SDO/AIA):** Solar imagery and data
- **NASA CCMC:** Coronal Mass Ejection tracking
- **CACTUS CME Catalog:** Solar event database
- **Nominatim/OpenStreetMap:** Location name lookup (when needed)

### We DO NOT
- Sell your personal information to any third parties
- Share location data with advertisers or marketing companies
- Track you across other websites or apps
- Store unnecessary personal data or create user profiles
- Use cookies or tracking pixels for advertising
- Share notification preferences or alert history with external services

---

## Data Security

- **Encryption:** All data transmission uses HTTPS/TLS encryption
- **Local Storage:** Most data is processed locally on your device
- **Minimal Collection:** We collect only data necessary for aurora forecasting
- **Automatic Deletion:** Temporary data expires after app sessions
- **No Permanent Storage:** Location data is not permanently stored on our servers
- **Secure Infrastructure:** App hosted on secure, regularly updated servers
- **Notification Security:** Alert data stored locally with device-level encryption

---

## Your Rights

You have the right to:
- **Access:** Request information about data we may have
- **Deletion:** Request removal of any stored notification preferences
- **Correction:** Update or correct your app settings
- **Portability:** Export your app settings and preferences
- **Opt-out:** Disable location services, notifications, or device permissions at any time
- **Control:** Modify notification thresholds and alert preferences

To exercise these rights, contact us at **matt@auroratracker.app**. We respond within 48 hours.

---

## Children's Privacy

AuroraTracker is intended for general audiences interested in aurora viewing and space weather. We do not knowingly collect personal information from children under 13.

If you believe a child has provided us with personal information, please contact us immediately at **privacy@auroratracker.app** and we will take steps to remove such information.

---

## Location Services

- **Permission:** We request location access only for aurora visibility calculations
- **Alternatives:** You can manually enter coordinates instead of using GPS
- **Accuracy:** We only need general location (city-level) for aurora forecasting
- **Control:** You can deny location access and still use most app features
- **Privacy:** Location data is processed locally and not stored permanently
- **Transparency:** Location usage is clearly indicated in the app interface

---

## Push Notifications & Device Permissions

### Geomagnetic Storm Notifications
We send:
- Geomagnetic storm alerts when conditions reach your selected threshold (G1–G5)
- Aurora visibility forecasts for your general area
- Significant space weather events that may affect aurora visibility
- One notification per storm level to avoid spam (G2→G3→G4 escalation allowed)

### Notification Frequency & Control
- **Alerts Only:** Notifications sent only during significant geomagnetic storms
- **No Spam:** Smart detection prevents repeated notifications for the same storm level
- **User Control:** Set your own G-level threshold (G1 Minor to G5 Extreme)
- **Typical Frequency:** 1–5 notifications per month during active solar periods
- **Sound & Vibration:** Customizable notification preferences in settings

---

## Device Permissions Explained

### Notification Permissions (POST_NOTIFICATIONS)
- **Purpose:** Required by Android 13+ to display geomagnetic storm alerts
- **Usage:** Only for aurora-related notifications, no marketing or spam
- **Control:** Can be revoked anytime in device settings or app settings

### Boot Completion (RECEIVE_BOOT_COMPLETED)
- **Purpose:** Ensures storm alert notifications work after device restart
- **Usage:** Only reschedules pending aurora alerts, no data collection
- **Privacy:** No personal information accessed during boot process

### Vibration & Sound (VIBRATE)
- **Purpose:** Provides tactile and audio feedback for storm notifications
- **Usage:** Only activates during geomagnetic storm alerts
- **Customization:** Can be disabled independently in notification settings

### Do Not Disturb (ACCESS_NOTIFICATION_POLICY)
- **Purpose:** Allows app to respect Do Not Disturb settings
- **Usage:** Ensures storm alerts follow your device quiet hours
- **Privacy:** Only reads system DND status, no personal data accessed

---

## Technical Implementation

- Built with Flutter for cross-platform compatibility
- Uses public APIs (NOAA, NASA, etc.) for space weather data
- Local notification system with no external tracking
- No proprietary tracking or analytics beyond basic app performance
- No permanent user accounts or profiles required
- Storm alert history kept locally for user convenience only
- Session data automatically expires after app closure

---

## Changes to This Policy

We may update this Privacy Policy periodically to reflect changes in our practices, new features, or for legal compliance. Changes will be posted in the app with an updated "Last Modified" date.

Continued use of AuroraTracker after changes constitutes acceptance of the updated policy. For significant changes affecting privacy or permissions, we may provide additional notice through the app or push notifications.
