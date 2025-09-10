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
  
  return "✨ ¡Hola! Soy Verónica Espinosa Sánchez, de MentExperta\n\n" +
         "¿Te gustaría conocer sobre nuestros servicios?\n\n" +
         "1️⃣ Trayectoria: Verónica Espinosa Sánchez & Isabella Matovelle\n" +
         "2️⃣ Horarios y costos\n" +
         "3️⃣ Psicoterapia Cognitiva: individual · pareja · familiar\n" +
         "4️⃣ Talleres: autoestima · comunicación · liderazgo\n" +
         "5️⃣ Evaluación Psicológica y Neuropsicológica\n" +
         "6️⃣ Estimulación Cognitiva\n" +
         "7️⃣ Peritajes\n" +
         "8️⃣ Ventajas de las sesiones por Zoom\n" +
         "9️⃣ Reservar cita & formas de pago\n" +
         "🔟 Dirección en Ecuador\n\n" +
         "🔒 *Confidencialidad garantizada*\n" +
         "💳 *Pagos:* Transferencia, DeUna, Payphone PayPal\n\n" +
         "✨ *Envía cualquier número (1-10) para más información*"
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
             "*Verónica Espinosa Sánchez & Isabella Matovelle*\n\n" +
             "*Verónica Espinosa Sánchez*\n" +
             "• Psicóloga Clínica con más de 28 años de experiencia\n" +
             "• Especializada en Psicoterapia Cognitiva (Albert Ellis Institute - NY)\n" +
             "• Atención a adolescentes y adultos\n" +
             "• Formación clínica y peritajes psicológicos\n" +
             "• Modalidades: Presencial (Quito) y Online (Zoom)\n\n" +
             "*Isabella Matovelle*\n" +
             "• Psicóloga colaboradora\n" +
             "• Especialista en terapias complementarias\n\n" +
             "✨ *Envía cualquier número (1-10) para más información*";

    case "2":
      return "⏰ *Horarios y Costos*\n\n" +
             "*📅 Horarios:*\n" + clinicHours + "\n\n" +
             "*💰 Tarifas:*\n" + clinicPrices + "\n\n" +
             "*📍 Ubicación:*\n" + clinicAddress + "\n\n" +
             "*☎️ Contacto:*\n" + clinicPhone + "\n" + clinicEmail + "\n\n" +
             "✨ *Envía cualquier número (1-10) para más información*";

    case "3":
      return "🧠 *Psicoterapia Cognitiva*\n\n" +
             "*Individual:* Identifica y modifica pensamientos que influyen en emociones y comportamientos. Técnicas claras para generar cambios reales en ansiedad, depresión, estrés.\n\n" +
             "*Técnicas utilizadas:*\n" +
             "✅ Comprender la conexión pensamiento–emoción–conducta\n\n" +
             "*Pareja:* Mejora la comunicación, resuelve conflictos y establece metas claras en la relación.\n\n" +
             "*Familiar:* Fortalece vínculos familiares y resuelve dinámicas conflictivas.\n\n" +
             "📋 *Primera sesión:* Evaluación inicial, explicación del proceso y resolución de dudas.\n\n" +
             "✨ *Envía cualquier número (1-10) para más información*";

    case "4":
      return "🎯 *Talleres Especializados*\n\n" +
             "*Talleres disponibles:*\n" +
             "• Autoestima y confianza personal\n" +
             "• Comunicación efectiva\n" +
             "• Liderazgo y desarrollo personal\n" +
             "• Manejo de estrés y ansiedad\n" +
             "• Relaciones interpersonales\n\n" +
             "*Modalidad:* Grupos terapéuticos especializados\n" +
             "*Duración:* Variable según el taller\n" +
             "*Beneficios:* Aprendizaje grupal y apoyo mutuo\n\n" +
             "✨ *Envía cualquier número (1-10) para más información*";

    case "5":
      return "📋 *Evaluación Psicológica y Neuropsicológica*\n\n" +
             "*Evaluación Psicológica:*\n" +
             "• Estado emocional y personalidad\n" +
             "• Relaciones interpersonales\n" +
             "• Evaluación de bullying\n" +
             "• Orientación vocacional\n" +
             "• Trastornos de conducta\n" +
             "• Modalidades: Presencial y Online\n\n" +
             "*Evaluación Neuropsicológica:*\n" +
             "• Entrevista clínica especializada\n" +
             "• Pruebas originales y validadas\n" +
             "• Informe detallado con recomendaciones\n" +
             "• 2-4 sesiones presenciales en Quito\n\n" +
             "✨ *Envía cualquier número (1-10) para más información*";

    case "6":
      return "🧠 *Estimulación Cognitiva*\n\n" +
             "*Áreas de trabajo:*\n" +
             "• Atención y concentración\n" +
             "• Memoria (corto y largo plazo)\n" +
             "• Lenguaje y comunicación\n" +
             "• Razonamiento lógico\n" +
             "• Funciones ejecutivas\n\n" +
             "*Herramientas especializadas:*\n" +
             "• NeuronUP (plataforma digital)\n" +
             "• Decedario PRO\n" +
             "• Planes personalizados\n\n" +
             "*Dirigido a:* Personas con deterioro cognitivo, lesiones cerebrales, o que deseen mantener y mejorar sus capacidades mentales.\n\n" +
             "✨ *Envía cualquier número (1-10) para más información*";

    case "7":
      return "⚖️ *Peritajes*\n\n" +
             "*Servicios especializados:*\n" +
             "• Peritajes psicológicos forenses\n" +
             "• Evaluaciones neuropsicológicas legales\n" +
             "• Pruebas originales y validadas\n\n" +
             "*Características:*\n" +
             "• Informes claros y precisos\n" +
             "• Sustentables en audiencia\n" +
             "• Metodología científica rigurosa\n" +
             "• Experiencia en el ámbito legal\n\n" +
             "*¿Necesitas un peritaje?* Agenda una primera cita para coordinar el proceso.\n\n" +
             "✨ *Envía cualquier número (1-10) para más información*";

    case "8":
      return "💻 *Ventajas de las sesiones por Zoom*\n\n" +
             "*✅ Eficacia comprobada:*\n" +
             "La evidencia científica muestra eficacia similar entre terapia virtual y presencial.\n\n" +
             "*✅ Comodidad y accesibilidad:*\n" +
             "• Desde tu hogar u oficina\n" +
             "• Ahorro de tiempo de traslado\n" +
             "• Horarios flexibles\n" +
             "• Acceso desde cualquier ciudad\n\n" +
             "*✅ Confidencialidad:*\n" +
             "• Plataforma segura\n" +
             "• Privacidad garantizada\n" +
             "• Mismo nivel profesional\n\n" +
             "*🌐 Horarios Zoom:* Lun-Vie 14:30-18:30; Dom solo urgencias\n\n" +
             "✨ *Envía cualquier número (1-10) para más información*";

    case "9":
      return "📅 *Reservar cita & formas de pago*\n\n" +
             "*Para agendar tu sesión necesito:*\n" +
             "• Nombre completo\n" +
             "• Ciudad/País de residencia\n" +
             "• Modalidad preferida (Presencial/Zoom)\n" +
             "• 2 opciones de día y horario\n" +
             "• Motivo de consulta (breve)\n\n" +
             "📸 Instagram: https://www.instagram.com/veronica_espinosa_sanchez/\n" +
             "💼 LinkedIn: https://www.linkedin.com/in/veronicaespinosasanchez/\n\n" +
             "🔗 Agenda Verónica: " + bookingLink + "\n" +
             "💳 Transferencia · DeUna · PayPhone · PayPal\n\n" +
             "ADOLESCENTES · ADULTOS · PAREJAS · FAMILIAS\n" +
             "Español · inglés · francés intermedio\n\n" +
             "Agenda Isabella (virtual): https://wa.me/34664589316\n" +
             "Si no ves un horario a tu medida, escríbeme y lo ajustamos.\n\n" +
             "✨ *Envía cualquier número (1-10) para más información*";

    case "10":
      return "📍 *Dirección en Ecuador*\n\n" +
             "*Ubicación:*\n" + clinicAddress + "\n\n" +
             "*📞 Contacto:*\n" + clinicPhone + "\n" + clinicEmail + "\n\n" +
             "*🕐 Horarios presenciales:*\n" +
             "Lun-Vie: 8:30-12:30\nSáb: 8:30-11:30\n\n" +
             "*🌐 Horarios virtuales:*\n" +
             "Lun-Vie: 14:30-18:30\nDom: solo urgencias\n\n" +
             "*🚗 Cómo llegar:*\n" +
             "Hospital de los Valles, Cumbayá\nConsultorio 302 (junto Scala)\n\n" +
             "✨ *Envía cualquier número (1-10) para más información*";

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