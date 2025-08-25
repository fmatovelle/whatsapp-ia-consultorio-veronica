# 🤖 WhatsApp Psychology Clinic Bot

An intelligent WhatsApp chatbot for Verónica's psychology clinic that provides instant responses to patient inquiries, captures appointment leads, and integrates seamlessly with Twilio and OpenAI.

## 📖 Overview

This bot serves as the first point of contact for potential patients, handling common questions about services, pricing, schedules, and locations. When questions go beyond the FAQ system, it seamlessly transitions to AI-powered responses using OpenAI's GPT models.

### Key Features
- **📚 Smart FAQ System**: Instant responses to 15+ common questions
- **🤖 AI-Powered Chat**: OpenAI integration for complex conversations
- **📋 Automatic Lead Capture**: Identifies and captures booking information
- **🔔 Admin Notifications**: WhatsApp alerts when new leads are captured
- **💾 Session Management**: Maintains conversation history using Firestore
- **🚫 Spam Protection**: Duplicate message prevention and number blocking
- **⚡ Fast Response**: Sub-2-second response times

## 🏗️ Architecture

- **Platform**: Firebase Functions (Node.js 18)
- **Database**: Cloud Firestore (session storage)
- **AI**: OpenAI GPT-4o-mini
- **Messaging**: Twilio WhatsApp Business API
- **Hosting**: Google Cloud (via Firebase)

---

## 🚀 Quick Setup

### Prerequisites
- Firebase account with Blaze plan (pay-as-you-go)
- Twilio account with WhatsApp Business API access
- OpenAI API key

### 1. Install Firebase CLI
```bash
npm install -g firebase-tools
firebase login
```

### 2. Setup Project
```bash
# Create new directory and initialize
mkdir whatsapp-bot && cd whatsapp-bot
firebase init

# Select:
# ✅ Firestore
# ✅ Functions
```

### 3. Copy Files
Copy all the provided files to your project:
- `functions/index.js`
- `functions/package.json`
- `firebase.json`
- `firestore.rules`
- `firestore.indexes.json`

### 4. Install Dependencies
```bash
cd functions
npm install
```

### 5. Configure Environment Variables
```bash
# Essential configuration
firebase functions:config:set \
  openai.api_key="sk-your-openai-key" \
  openai.model="gpt-4o-mini" \
  twilio.account_sid="AC-your-twilio-sid" \
  twilio.auth_token="your-twilio-token" \
  twilio.whatsapp_from="whatsapp:+14155238886"

# Clinic information
firebase functions:config:set \
  clinic.name="Consultorio Verónica Espinosa" \
  clinic.phone="+593 2 2378987" \
  clinic.email="veronica.espinosa@hospitaldelosvalles.com" \
  clinic.address="Hospital de los Valles, Cumbayá, Consultorio 302" \
  clinic.hours="Presencial: Lun-Vie 08:30-12:30; Zoom: Lun-Vie 14:30-18:30" \
  clinic.services="Psicoterapia cognitiva, terapia de pareja, diagnóstico psicológico" \
  clinic.prices="Sesión individual US$70 (45min); Paquete 4 sesiones US$240"

# Booking configuration  
firebase functions:config:set \
  booking.link="https://calendar.app.google/your-calendar-link" \
  emergency.disclaimer="En emergencias llama al 911 o acude al centro médico más cercano"

# Optional: Admin notifications
firebase functions:config:set \
  admin.whatsapp="+593999999999" \
  enable.admin_notify="true"
```

### 6. Deploy
```bash
cd .. # Back to project root
firebase deploy
```

### 7. Configure Twilio Webhook
Use your Firebase Function URL in Twilio:
```
https://us-central1-your-project-id.cloudfunctions.net/whatsappWebhook
```

---

## 🏠 Local Development

### Start Local Environment
```bash
# Install emulators
firebase setup:emulators:firestore
firebase setup:emulators:functions

# Get config for local development
firebase functions:config:get > functions/.runtimeconfig.json

# Start emulators
firebase emulators:start
```

Your local webhook: `http://localhost:5001/project-id/us-central1/whatsappWebhook`

### Test Locally
```bash
# Health check
curl http://localhost:5001/project-id/us-central1/whatsappWebhook

# Send test message
curl -X POST http://localhost:5001/project-id/us-central1/whatsappWebhook \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "Body=hola&From=whatsapp:+593999999999&WaId=593999999999&ProfileName=Test&MessageSid=test123"
```

**Monitoring**: Visit `http://localhost:4000` for the Firebase Emulator UI

### Using ngrok for Real Twilio Testing
```bash
# Install ngrok and expose local port
ngrok http 5001

# Use the ngrok URL in Twilio webhook:
# https://abc123.ngrok.io/project-id/us-central1/whatsappWebhook
```

---

## ⚙️ Configuration

### FAQ Responses
The bot automatically responds to:
- **Greetings**: "hola", "buenas tardes", etc.
- **Pricing**: "cuanto cuesta", "precio", "tarifa"
- **Schedule**: "horarios", "disponibilidad", "cuando"
- **Location**: "direccion", "donde", "ubicacion"
- **Services**: "que haces", "servicios", "terapia"
- **Booking**: "agendar", "reservar", "cita"
- **Emergencies**: "emergencia", "suicidio", "crisis"

### Environment Variables Reference
| Variable | Purpose | Example |
|----------|---------|---------|
| `openai.api_key` | OpenAI authentication | `sk-...` |
| `twilio.account_sid` | Twilio authentication | `AC...` |
| `clinic.name` | Business name | `"Consultorio Verónica"` |
| `admin.whatsapp` | Notification numbers | `"+593999999999,+593888888888"` |
| `ignore.whatsapps` | Numbers to ignore | `"+593999999999"` |

### View Current Config
```bash
firebase functions:config:get
```

---

## 📊 Monitoring & Troubleshooting

### View Logs
```bash
# Production logs
firebase functions:log

# Specific function logs
firebase functions:log --only whatsappWebhook
```

### Common Issues

**"Config is empty"**
```bash
# Solution: Get config for local development
firebase functions:config:get > functions/.runtimeconfig.json
```

**"OpenAI timeout"**
- Check your API key and billing status
- Verify internet connectivity in Firebase environment

**"Firestore permission denied"**
- Verify firestore.rules are deployed
- Check that functions have admin access

**"Webhook not receiving messages"**
- Verify Twilio webhook URL is correct
- Check Twilio debugger for delivery issues
- Ensure Firebase Function is deployed and accessible

### Performance Monitoring
- **Firebase Console**: Function execution metrics
- **Twilio Console**: Message delivery rates
- **OpenAI Dashboard**: API usage and costs

---

## 🎯 Bot Behavior

### Example Interactions

**FAQ Response (instant):**
```
User: "hola"
Bot: "¡Hola! Soy Verónica, psicóloga clínica. 🧠 ¿En qué te ayudo hoy?"
```

**Pricing Inquiry:**
```
User: "cuanto cuesta"
Bot: "💳 Tarifas: Sesión individual US$70 (45–50 min); Paquete 4 sesiones US$240..."
```

**AI Response (for complex queries):**
```
User: "Tengo problemas de ansiedad desde hace meses"
Bot: [OpenAI generates empathetic response with booking suggestion]
```

**Lead Capture:**
When the bot detects name, reason, location, and preferred times, it:
1. Continues conversation normally with the user
2. Sends notification to admin WhatsApp numbers
3. Stores lead information for follow-up

### Session Management
- Maintains last 8 messages per user
- Automatic cleanup of old processed messages
- Persistent storage across function restarts

---

## 🔒 Security & Privacy

- **Firestore Rules**: Prevent client-side access to sensitive data
- **Environment Variables**: Encrypted by Firebase
- **API Rate Limiting**: OpenAI timeout protection
- **Message Deduplication**: Prevents processing same message twice
- **Number Blocking**: Configurable ignore list for spam prevention

---

## 🆙 Updates & Maintenance

### Deploy Updates
```bash
# Update function code
firebase deploy --only functions

# Update Firestore rules
firebase deploy --only firestore
```

### Update Environment Variables
```bash
# Change a variable
firebase functions:config:set clinic.price="New pricing info"

# Deploy to apply changes
firebase deploy --only functions
```

### Backup Data
Firestore automatically backs up your data, but you can export manually:
```bash
gcloud firestore export gs://your-project-backup-bucket
```

---

## 📞 Support

**Local Development Issues:**
1. Check emulator logs in terminal
2. Visit `http://localhost:4000` for detailed debugging
3. Verify `.runtimeconfig.json` exists in functions/

**Production Issues:**
1. Check `firebase functions:log`
2. Verify all environment variables are set
3. Test webhook URL accessibility
4. Review Twilio delivery reports

**Cost Optimization:**
- Monitor OpenAI usage in dashboard
- Set FAQ responses for common questions to reduce AI calls
- Configure ignored numbers to prevent spam costs

---

## 📄 License

This project is configured specifically for Verónica's Psychology Clinic. Modify the clinic information and configuration as needed for your use case.

---

**Built with ❤️ using Firebase Functions, OpenAI, and Twilio WhatsApp Business API**