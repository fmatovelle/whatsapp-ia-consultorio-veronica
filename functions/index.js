// index.js — Firebase Functions Gen 2 (Versión Simplificada Sin Firestore)
require('dotenv').config();

const { onRequest } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const functions = require('firebase-functions');

// Ajusta la región si corresponde (p. ej. 'europe-west1')
setGlobalOptions({ region: 'europe-west1' });

function sleep(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise(function(_, reject) {
      setTimeout(function() {
        reject(new Error("OPENAI_TIMEOUT"));
      }, ms);
    })
  ]);
}

function normalize(s) {
  if (!s) return "";
  return s.toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeXml(s) {
  if (!s) return "";
  return s.replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xml(m) {
  return '<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + escapeXml(m) + '</Message></Response>';
}

function loadConfig() {
  if (process.env.OPENAI_API_KEY) {
    return {
      openai: {
        api_key: process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_MODEL || "gpt-4o-mini"
      },
      twilio: {
        account_sid: process.env.TWILIO_ACCOUNT_SID,
        auth_token: process.env.TWILIO_AUTH_TOKEN,
        whatsapp_from: process.env.TWILIO_WHATSAPP_FROM
      },
      clinic: {
        name: process.env.CLINIC_NAME,
        address: process.env.CLINIC_ADDRESS,
        phone: process.env.CLINIC_PHONE,
        email: process.env.CLINIC_EMAIL,
        hours: process.env.CLINIC_HOURS,
        services: process.env.CLINIC_SERVICES,
        prices: process.env.CLINIC_PRICES
      },
      admin: {
        whatsapp: process.env.ADMIN_WHATSAPP
      },
      emergency: {
        disclaimer: process.env.EMERGENCY_DISCLAIMER
      },
      booking: {
        link: process.env.BOOKING_LINK,
        footer: process.env.BOOKING_FOOTER ? process.env.BOOKING_FOOTER.replace(/\\n/g, "\n") : ""
      },
      typing: {
        ms_faq: process.env.TYPING_MS_FAQ || "1200",
        ms_ai: process.env.TYPING_MS_AI || "1200"
      },
      enable: {
        admin_notify: process.env.ENABLE_ADMIN_NOTIFY === "true"
      },
      ignore: {
        whatsapps: process.env.IGNORE_WHATSAPPS || ""
      },
      log: {
        incoming: process.env.LOG_INCOMING === "true"
      }
    };
  }

  // fallback a config() si usas runtime config de Firebase
  return functions.config();
}

const config = loadConfig();

// Memoria temporal para sesiones (se reinicia con cada deploy)
const tempSessions = new Map();
const processedMessages = new Map();

function parseIgnored() {
  const raw = config.ignore && config.ignore.whatsapps ? config.ignore.whatsapps : "";
  const numbers = raw.split(/[,\s]+/).map(function(s) { return s.trim(); }).filter(Boolean);
  const set = new Set();

  for (let i = 0; i < numbers.length; i++) {
    const n = numbers[i];
    const v = n.toLowerCase().replace(/\s/g, "");
    const noProto = v.replace(/^whatsapp:/, "");
    const digits = noProto.replace(/[^\d]/g, "");
    if (noProto) set.add(noProto);
    if (digits) set.add(digits);
  }
  return set;
}

function isIgnored(from, waId) {
  const ig = parseIgnored();
  if (!ig.size) return false;

  function canon(v) {
    if (!v) return [];
    v = v.toLowerCase().replace(/\s/g, "");
    const noProto = v.replace(/^whatsapp:/, "");
    const digits = noProto.replace(/[^\d]/g, "");
    const result = [];
    if (noProto) result.push(noProto);
    if (digits) result.push(digits);
    return result;
  }

  const candidates = [];
  const fromCandidates = canon(from);
  const waIdCandidates = canon(waId);

  for (let i = 0; i < fromCandidates.length; i++) candidates.push(fromCandidates[i]);
  for (let i = 0; i < waIdCandidates.length; i++) candidates.push(waIdCandidates[i]);

  for (let i = 0; i < candidates.length; i++) {
    if (ig.has(candidates[i])) return true;
  }
  return false;
}

function alreadyProcessed(sid) {
  if (!sid) return false;
  
  // Limpiar mensajes viejos (más de 5 minutos)
  const now = Date.now();
  const TTL = 5 * 60 * 1000;
  
  for (const [key, timestamp] of processedMessages) {
    if (now - timestamp > TTL) {
      processedMessages.delete(key);
    }
  }
  
  if (processedMessages.has(sid)) {
    console.log("Duplicate message detected: " + sid);
    return true;
  }
  
  processedMessages.set(sid, now);
  return false;
}

function getMainMenu() {
  const bookingLink = config.booking && config.booking.link ? config.booking.link : "";
  
  return "🌿 *¡Hola! Soy Verónica Espinosa Sánchez, de MentExperta*\n\n" +
         "Por favor dime tu nombre y accede a información importante hasta comunicarme directamente contigo:\n\n" +
         "¿Te gustaría conocer sobre nuestros servicios? 👇\n\n" +
         "1️⃣ Trayectoria Profesional\n" +
         "2️⃣ Horarios y Costos\n" +
         "3️⃣ Psicoterapia Cognitiva\n" +
         "4️⃣ Talleres\n" +
         "5️⃣ Evaluación Psicológica y Neuropsicológica\n" +
         "6️⃣ Estimulación Cognitiva\n" +
         "7️⃣ Peritajes\n" +
         "8️⃣ Ventajas Sesiones Zoom\n" +
         "9️⃣ Agendar & Pagos\n" +
         "🔟 Dirección Ecuador\n\n" +
         "*ADOLESCENTES • ADULTOS • PAREJAS • FAMILIAS*\n" +
         "Español • inglés • francés intermedio\n\n" +
         "💳 Transferencia • DeUna • PayPhone • PayPal\n\n" +
         "🔗 Reserva aquí: https://calendar.app.google/AYpn6gze1eeQV2icA\n\n" +
         "✨ *Envía cualquier número (1-10) para más información:*\n\n";

}

function getMenuResponse(option) {
  const clinicAddress = config.clinic && config.clinic.address ? config.clinic.address : "";
  const clinicPhone = config.clinic && config.clinic.phone ? config.clinic.phone : "";
  const clinicEmail = config.clinic && config.clinic.email ? config.clinic.email : "";
  const clinicHours = config.clinic && config.clinic.hours ? config.clinic.hours : "";
  const clinicPrices = config.clinic && config.clinic.prices ? config.clinic.prices : "";
  const bookingLink = config.booking && config.booking.link ? config.booking.link : "";

  switch(option) {
case "1":
  return "👩‍⚕️ *Trayectoria Profesional*\n\n" +
         "*Verónica Espinosa Sánchez*\n" +
         "• Psicóloga Clínica (28+ años de experiencia)\n" +
         "• Neuropsicóloga, Master en Dirección Talento Humano\n" +
         "• Perito Psicóloga acreditada ante CJI\n" +
         "• Psicoterapia Cognitiva (Albert Ellis Institute, NY)\n\n" +
         "*Isabella Matovelle Espinosa*\n" +
         "• Psicóloga Clínica y Life Coach\n" +
         "• Psicóloga juvenil\n" +
         "• Especializada en adolescentes, jóvenes adultos y padres\n" +
         "• Mirada profunda y juvenil\n\n" +
         "💡 *Nuestro enfoque*: Ciencia + Empatía + Estrategia\n\n" +
         "🌐 Web: https://mentexperta.com/\n" +
         "📸 Instagram: https://www.instagram.com/veronica_espinosa_sanchez/\n" +
         "💼 LinkedIn: https://www.linkedin.com/in/veronicaespinosasanchez/\n\n" +
         "✅ *Agenda Verónica*: https://calendar.app.google/AYpn6gze1eeQV2icA\n\n"+
         "*Agenda Isabella (virtual):* https://wa.me/34664589316 \n\n" +
         "✨ *Envía cualquier número (1-10) para más información*";
        

case "2":
  return "📅 *Horarios y Costos*\n\n" +
         "*Presencial (Quito - Hospital de los Valles)*\n" +
         "🕘 L-V 8:30 - 12:30 | Sáb 8:30 - 11:30\n\n" +
         "*Online por Zoom*\n" +
         "💻 L-V 14:30 - 18:30 | Domingo: solo emergencias\n\n" +
         "💳 *Tarifas:*\n" +
         "• Sesión individual: US$70\n" +
         "• Paquete de 4 sesiones: US$240\n\n" +
         "📅 *Agendar:*\n" +
         "• Verónica: https://calendar.app.google/AYpn6gze1eeQV2icA\n" +
         "• Isabella: https://wa.me/34664589316\n\n" +
         "¿No encuentras el horario que te resulta mejor? ¡Escríbeme!\n\n" +
         "✨ *Envía cualquier número (1-10) para más información*";


case "3":
  return "🧠 *Psicoterapia Cognitiva*\n\n" +
         "*INDIVIDUAL • PAREJA • FAMILIAR*\n\n" +
         "✅ Identifica y modifica pensamientos/creencias negativas que afectan emociones y conductas\n" +
         "✅ Técnicas: reestructuración cognitiva, habilidades de afrontamiento\n" +
         "✅ Comprender la conexión pensamiento–emoción–conducta\n\n" +
         "⏱️ *Duración:*\n" +
         "• Individual: 45 min\n" +
         "• Pareja/familia: 90 min (primera sesión recomendada)\n\n" +
         "📅 *Agendar:*\n" +
         "• Verónica: https://calendar.app.google/AYpn6gze1eeQV2icA\n" +
         "• Isabella: https://wa.me/34664589316\n\n" +
         "✨ *Envía cualquier número (1-10) para más información*";

case "4":
  return "✨ *Talleres*\n\n" +
         "*Autoestima, Comunicación y Liderazgo*\n\n" +
         "📅 Inicio: primer jueves de cada mes - Online\n" +
         "👥 Grupos: 4 personas (precio especial)\n" +
         "⏰ 1.5 h semanales\n" +
         "💰 $240/mes\n\n" +
         "📧 Escríbeme para coordinar tu participación\n\n" +
         "✨ *Envía cualquier número (1-10) para más información*";

case "5":
  return "🧠 *Evaluación Psicológica y Neuropsicológica*\n\n" +
         "*NIÑOS, ADOLESCENTES Y ADULTOS*\n\n" +
         "*Áreas evaluadas:*\n" +
         "✅ Trastornos emocionales y de conducta: ansiedad, depresión, TOC, TEPT\n" +
         "✅ Trastornos de la Personalidad\n" +
         "✅ Personalidad y vínculos familiares/sociales\n" +
         "✅ Bullying y acoso laboral\n" +
         "✅ Orientación vocacional\n" +
         "✅ Funcionamiento cognitivo\n\n" +
         "*Proceso*: Entrevista + Pruebas originales (validez internacional) + Informe escrito\n\n" +
         "💬 Solicita niveles de evaluación y precios\n\n" +
         "Agenda Verónica: Terapia\n" +
         "https://calendar.app.google/AYpn6gze1eeQV2icA\n\n" +
         "✨ *Envía cualquier número (1-10) para más información*";

case "6":
  return "🧩 *Estimulación y Rehabilitación Cognitiva*\n\n" +
         "*NIÑOS, ADOLESCENTES, ADULTOS Y ADULTOS MAYORES*\n\n" +
         "*Áreas*: Atención, Memoria, Lenguaje, Funciones ejecutivas, Orientación, Velocidad de procesamiento, Habilidades visoespaciales\n\n" +
         "*Herramientas especializadas:*\n" +
         "📝 Papel y lápiz\n" +
         "🎯 Decedario\n" +
         "💻 NeuronUP (digital)\n\n" +
         "*Dirigido a*: Deterioro cognitivo, lesiones cerebrales, trastornos del neurodesarrollo, TCE, ACV, TDAH, TEA, S. Down\n\n" +
         "💬 Solicita niveles de evaluación y precios\n" +
         "📅 Agenda: https://calendar.app.google/AYpn6gze1eeQV2icA\n\n" +
         "Agenda: Terapia\n" +
         "https://calendar.app.google/AYpn6gze1eeQV2icA\n\n" +
         "✨ *Envía cualquier número (1-10) para más información*";

case "7":
  return "⚖️ *Peritajes Psicológicos*\n\n" +
         "Perito Psicóloga acreditada ante el Consejo de la Judicatura (1833413)\n\n" +
         "*Servicios especializados:*\n" +
         "• Peritajes psicológicos y neuropsicológicos\n" +
         "• Pruebas originales y con validez internacional\n" +
         "• Informes claros y sustentables\n" +
         "• Comprobables científicamente en audiencia\n\n" +
         "📧 Escríbeme para coordinar la evaluación\n" +
         "📅 Agenda: https://calendar.app.google/AYpn6gze1eeQV2icA\n\n" +
         "✨ *Envía cualquier número (1-10) para más información*";

case "8":
  return "💻 *Ventajas de las sesiones por Zoom*\n\n" +
         "🎓 *Estudios confirman:*\n" +
         "✅ Igual eficacia que la presencial (APA, 2020)\n" +
         "✅ Incluso mayor bienestar a 3 meses (Univ. Zürich, 2014)\n\n" +
         "⭐ *Beneficios adicionales:*\n" +
         "• Comodidad desde tu hogar\n" +
         "• Ahorro de tiempo de desplazamiento\n" +
         "• Acceso desde cualquier lugar\n" +
         "• Misma calidad profesional\n\n" +
         "📅 *Agenda:*\n" +
         "• Verónica: https://calendar.app.google/AYpn6gze1eeQV2icA\n" +
         "• Isabella: https://wa.me/34664589316\n\n" +
         "✨ *Envía cualquier número (1-10) para más información*";

case "9":
  return "💳 *Agendar cita y Formas de Pago*\n\n" +
         "📅 *Agenda:*\n" +
         "• Verónica: https://calendar.app.google/AYpn6gze1eeQV2icA\n" +
         "• Isabella: https://wa.me/34664589316\n\n" +
         "💳 *Pagos:*\n" +
         "🇪🇨 *Transferencia Ecuador*\n" +
         "María Verónica Espinosa Sánchez | CI: 1704195500\n" +
         "Banco Pichincha - Cta Cte: 3014717004\n\n" +
         "🇪🇸 *Transferencia España*\n" +
         "IBAN: ES98 0049 2352 03 28 1434 3918\n\n" +
         "🌐 *PayPal*: https://paypal.me/vespinosasanchez\n" +
         "📱 *PayPhone*: https://payp.page.link/qWfv\n" +
         "💳 *Transferencia • DeUna • PayPhone • PayPal*\n\n" +
         "Agenda Verónica\n" +
         "https://calendar.app.google/AYpn6gze1eeQV2icA\n\n"+
         "✨ *Envía cualquier número (1-10) para más información*";

case "10":
  return "📍 *Dirección en Ecuador*\n\n" +
         "*Verónica Espinosa Sánchez - Consultorio*\n\n" +
         "🏥 Edificio de Especialidades Médicas\n" +
         "Hospital de los Valles\n" +
         "Av. Interoceánica Km 12.5 y Florencia - Cumbayá\n" +
         "Consultorio 302 (junto a Scala)\n\n" +
         "📞 *Contacto:*\n" +
         "🏥 Consultorio: +593 2 2378987\n" +
         "📱 WhatsApp: +593 9 84255556\n" +
         "📧 Email: veronica.espinosa@hospitaldelosvalles.com\n\n" +
         "🚀 Google Maps: https://maps.app.goo.gl/q7Nqs4PngPGELuzS8\n\n" +
         "📱 *Menú principal*: 🔢 Envía cualquier número (1-10)\n\n" +
         "Terapia:\n" +
         "https://calendar.app.google/AYpn6gze1eeQV2icA\n\n" +
         "✨ Envía cualquier número (1-10) para más información";

    default:
      return null;
  }
}

function faq(raw) {
  const q = normalize(raw);

  // Check for menu option numbers FIRST (now including 9 and 10)
  if (/^(10|[1-9])$/.test(raw.trim())) {
    return getMenuResponse(raw.trim());
  }

  // Emergency check
  if (/(emergencia|urgencia|suicid|autolesion|riesgo|crisis)/.test(q)) {
    const disclaimer = config.emergency && config.emergency.disclaimer ? config.emergency.disclaimer : "";
    return disclaimer;
  }

  // ANY greeting or menu request - ALWAYS show menu
  if (/(^hola|^buenas|^buenos|^buen dia|^hi|^hello|^hey|saludos|que tal|como esta|como estas|estimada|doctora|psicologa|veronica|verónica|buenos dias|buenas tardes|buenas noches|buen dia|menu|inicio|opciones|servicios|que haces|que ofreces|informacion|ayuda|que puedes hacer|ola|buebas|buenoa|olis|holiwis)/.test(q)) {
    return getMainMenu();
  }

  // Quick responses for specific keywords - route to menu sections
  if (/(precio|costo|tarifa|cuanto vale|cuanto cuesta|horario|hora|disponibilidad|agenda|turno|cuando puedes)/.test(q)) {
    return getMenuResponse("2");
  }

  if (/(direccion|donde|ubicacion|como llegar|mapa|maps|hospital de los valles|cumbaya)/.test(q)) {
    return getMenuResponse("10");
  }

  if (/(agendar|reservar|cita|turno|zoom|presencial|instagram|linkedin|agenda|isabella)/.test(q)) {
    return getMenuResponse("9");
  }

  if (/(terapia cognitiva|psicoterapia|que es la terapia)/.test(q)) {
    return getMenuResponse("3");
  }

  if (/(talleres|autoestima|comunicacion|liderazgo)/.test(q)) {
    return getMenuResponse("4");
  }

  if (/(diagnostico|evaluacion|test|pruebas|neuropsicolog)/.test(q)) {
    return getMenuResponse("5");
  }

  if (/(estimulacion|rehabilitacion|cognitiva|memoria|atencion)/.test(q)) {
    return getMenuResponse("6");
  }

  if (/(peritaje|legal|forense|judicial)/.test(q)) {
    return getMenuResponse("7");
  }

  if (/(zoom|virtual|online|videollamada|ventajas)/.test(q)) {
    return getMenuResponse("8");
  }

  if (/(trayectoria|experiencia|quien eres|curriculum|sobre ti|isabella|matovelle)/.test(q)) {
    return getMenuResponse("1");
  }

  return null;
}

exports.whatsappWebhook = onRequest((req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'GET') {
    res.status(200).send('OK - WhatsApp Bot is running on Firebase Functions (Updated Version)');
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  console.log("=== NEW MESSAGE RECEIVED ===");

  const Body = req.body.Body ? req.body.Body.trim() : "";
  const From = req.body.From;
  const WaId = req.body.WaId || From;
  const ProfileName = req.body.ProfileName || "";
  const MessageSid = req.body.MessageSid || req.body.SmsSid || req.body.SmsMessageSid;

  if (config.log && config.log.incoming) {
    console.log("Message details:", {
      From: From,
      WaId: WaId,
      Body: Body.substring(0, 100),
      MessageSid: MessageSid,
      ProfileName: ProfileName
    });
  }

  if (isIgnored(From, WaId)) {
    console.log("User is ignored, no response sent");
    res.status(204).send('');
    return;
  }

  if (alreadyProcessed(MessageSid)) {
    console.log("Duplicate message, skipping");
    res.status(204).send('');
    return;
  }

  // Try FAQ first (including menu responses)
  const quick = faq(Body);
  if (quick) {
    console.log("FAQ/Menu response found, sending quick reply");

    const typingDelay = config.typing && config.typing.ms_faq ? config.typing.ms_faq : "1200";
    sleep(Number(typingDelay)).then(function() {
      res.set('Content-Type', 'application/xml');
      res.status(200).send(xml(quick));
      console.log("FAQ/Menu response sent successfully");
    }).catch(function(error) {
      console.error("Error in FAQ flow:", error);
      res.set('Content-Type', 'application/xml');
      res.status(200).send(xml("Perdón, tuve un problema técnico. Envía 'menu' para ver mis servicios."));
    });
    return;
  }

  console.log("No FAQ/Menu match, using fallback");
  
  // Fallback response 
  const fallbackResponse = 'Gracias por escribirme 🌿 ¿Te gustaría ver mi menú de servicios? Envía "hola" para conocer todas las opciones disponibles.';
  
  const aiTypingDelay = config.typing && config.typing.ms_ai ? config.typing.ms_ai : "1200";
  sleep(Number(aiTypingDelay)).then(function() {
    res.set('Content-Type', 'application/xml');
    res.status(200).send(xml(fallbackResponse));
    console.log("=== MESSAGE PROCESSED SUCCESSFULLY ===");
  }).catch(function(err) {
    console.error("Handler error:", err);
    const safe = "Perdón, tuve un inconveniente técnico. Envía 'hola' para ver mis servicios.";
    res.set('Content-Type', 'application/xml');
    res.status(200).send(xml(safe));
  });
});

exports.healthCheck = onRequest((req, res) => {
  res.status(200).send('OK - WhatsApp Bot is running on Firebase Functions (Updated)');
});