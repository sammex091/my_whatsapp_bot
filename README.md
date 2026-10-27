# WhatsApp bot starter (Android / Termux)

1. Install Termux from F-Droid.
2. In Termux run: `pkg update && pkg upgrade -y && pkg install nodejs-lts git nano -y`
3. Put these project files in a folder and run `npm install`.
4. Copy `.env.example` to `.env` and set `BOT_PHONE_NUMBER` to your WhatsApp number in international digits, without plus signs or spaces.
5. Run `npm start` and use WhatsApp > Linked devices > Link a device > Link with phone number instead. Enter the code shown in Termux.

Keep `auth_info/` and `.env` private. Do not upload them to GitHub. Use only with an account you control and respect WhatsApp rules. Group moderation actions need permissions.
