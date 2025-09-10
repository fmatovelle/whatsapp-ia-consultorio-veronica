// ===== Estado efímero (no garantizado entre invocaciones) =====
const sessions = new Map();          // waId -> { history: [...] }
const processedSids = new Map();     // sid -> timestamp
const SID_TTL_MS = 5 * 60 * 1000;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("OPENAI_TIMEOUT")), ms))]);

const normalize = (s = "") =>
  s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();

const escapeXml = (s = "") =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
   .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const xml = (m) => `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(m || "")}</Message></Response>`;

function pushMessage(waId, role, content) {
  const s = sessions.get(waId) || { history: [] };
  s.history.push({ role, content });
  if (s.history.length > 8) s.history = s.history.slice(-8);
  sessions.set(waId, s);
  console.log(`Session updated for ${waId}, history length: ${s.history.length}`);
}
const messagesForUser = (waId) => (sessions.get(waId) || { history: [] }).history;

function alreadyProcessed(sid) {
  const now = Date.now();
  // Clean old entries
  for (const [k, t] of processedSids) if (now - t > SID_TTL_MS) processedSids.delete(k);
  if (!sid) return false;
  if (processedSids.has(sid)) {
    console.log(`Duplicate message detected: ${sid}`);
    return true;
  }
  processedSids.set(sid, now);
  return false;
}

// ===== Silencio por número (no responde) =====
function parseIgnored(env) {
  const raw = (env.IGNORE_WHATSAPPS || "")
    .split(/[,\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
  const set = new Set();
  for (const n of raw) {
    const v = n.toLowerCase().replace(/\s/g, "");
    const noProto = v.replace(/^whatsapp:/, "");
    const digits = noProto.replace(/[^\d]/g, "");
    if (noProto) set.add(noProto);
    if (digits) set.add(digits);
  }
  return set;
}
function isIgnored(env, from, waId) {
  const ig = parseIgnored(env);
  if (!ig.size) return false;
  const canon = (v = "") => {
    v = v.toLowerCase().replace(/\s/g, "");
    const noProto = v.replace(/^whatsapp:/, "");
    const digits = noProto.replace(/[^\d]/g, "");
    return [noProto, digits].filter(Boolean);
  };
  const candidates = [...canon(from), ...canon(waId)];
  return candidates.some(v => ig.has(v));
}

// ===== Prompt del sistema =====
const SYS = (env) => `
Eres la psicóloga clínica Verónica (Consultorio: "${env.CLINIC_NAME}", Quito — Hospital de los Valles, Cumbayá).
Trayectoria Profesional: Verónica Espinosa Sánchez & Isabella Matovelle.
Responde SIEMPRE en primera persona, con calidez y brevedad (2—4 líneas). Usa emojis de forma natural y moderada (🌿✨🧠🤝😊).
Objetivo: resolver dudas y motivar a agendar una cita presencial u online por Zoom.

Datos:
• Dirección: ${env.CLINIC_ADDRESS}
• Teléfono: ${env.CLINIC_PHONE}
• Email: ${env.CLINIC_EMAIL}
• Horarios: ${env.CLINIC_HOURS}
• Servicios: ${env.CLINIC_SERVICES}
• Precios: ${env.CLINIC_PRICES}
• Emergencias: ${env.EMERGENCY_DISCLAIMER}

Redes Sociales:
• 📸 Instagram: https://www.instagram.com/veronica_espinosa_sanchez/
• 💼 LinkedIn: https://www.linkedin.com/in/veronicaespinosasanchez/

Estilo:
• Cercano y empático; sin diagnósticos por chat.
• No propongas horarios concretos salvo que el usuario pregunte por disponibilidad o quiera agendar.
• Si te piden horarios, entonces sí ofrece 1—2 opciones y CTA a reservar.

Instrucción para LEAD (no mostrar al usuario):
Cuando obtengas nombre, motivo, ciudad/país, modalidad y 1—2 franjas horarias, añade en la ÚLTIMA línea (no visible para el usuario):
LEAD: {"name":"...", "reason":"...", "city":"...", "preferred_times":["...","..."], "modality":"presencial/zoom", "phone":"{{PHONE}}"}
`;

const extractLead = (t) => {
  const m = t?.match(/LEAD:\s*(\{[\s\S]*\})/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
};
const stripLead = (t = "") =>
  t.split("\n").filter(l => !l.trim().startsWith("LEAD:")).join("\n").trim();

function footer(env) {
  const f = (env.BOOKING_FOOTER || "").replace(/\\n/g, "\n").trim();
  return f || (
    `\n\n📅 Agenda Verónica: ${env.BOOKING_LINK}\n` +
    `📅 Agenda Isabella (virtual): https://wa.me/34664589316\n` +
    `🏠 Presencial 8:30—12:30 | 🌐 Online 14:30—18:30\n` +
    `🕐 Duración: 45 minutos | Frecuencia semanal\n` +
    `Si no ves un horario a tu medida, escríbeme y lo ajustamos.`
  );
}

// ===== FAQs (controlando si se muestra agenda) =====
function faq(raw, env, showBooking = false) {
  const q = normalize(raw);
  const booking = showBooking ? footer(env) : "";

  if (/(emergencia|urgencia|suicid|autolesion|riesgo|crisis)/.test(q))
    return `${env.EMERGENCY_DISCLAIMER}`;

  // Saludo
  if (/^(hola|buenas|buenos dias|buenas tardes|buenas noches|hi|hello)\b/.test(q)) {
    return showBooking
      ? `¡Hola! Soy Verónica, psicóloga clínica. 🧠 Trabajo con psicoterapia cognitiva para ansiedad, depresión, conflictos, pareja y familia. ¿Te gustaría agendar una sesión presencial en Cumbayá o por Zoom?${booking}`
      : `¡Hola! Soy Verónica, psicóloga clínica. 🧠 ¿En qué te ayudo hoy?`;
  }

  if (/(precio|costo|tarifa|cuanto vale|cuanto cuesta)/.test(q))
    return `💳 Tarifas: ${env.CLINIC_PRICES}\n⏱️ La sesión individual dura ~45—50 min; en pareja/familia se recomienda sesión doble.${booking}`;

  if (/(horario|hora|disponibilidad|agenda|turno|cuando puedes)/.test(q))
    return `🗓️ Horarios: ${env.CLINIC_HOURS}\n¿Te comparto disponibilidad por aquí o prefieres ver la agenda?${booking}`;

  if (/(direccion|donde|ubicacion|como llegar|mapa|maps|hospital de los valles|cumbaya)/.test(q))
    return `📍 Estoy en el Hospital de los Valles (Cumbayá). ${env.CLINIC_ADDRESS}\nTel: ${env.CLINIC_PHONE} · Email: ${env.CLINIC_EMAIL}${booking}`;

  if (/(quien eres|tu experiencia|sobre ti|sobre usted|conocerte|perfil|trayectoria)/.test(q))
    return `✨ Soy psicóloga clínica especializada en psicoterapia cognitiva (Albert Ellis Institute — NY) con más de 28 años de experiencia. Acompaño a adolescentes y adultos; también realizo formación clínica y peritajes. Atiendo en Quito y por Zoom 🌐.\n\n📸 Instagram: https://www.instagram.com/veronica_espinosa_sanchez/\n💼 LinkedIn: https://www.linkedin.com/in/veronicaespinosasanchez/${booking}`;

  if (/(estimula|rehabilita).*cognit|neuronup/.test(q))
    return `🧠 Estimulación y Rehabilitación Cognitiva: atención, memoria, lenguaje, razonamiento y funciones ejecutivas. Uso NeuronUP, Decedario PRO y planes personalizados.${booking}`;

  if (/(diagnostico neuropsicolog|neuropsicol)/.test(q))
    return `🧠 Diagnóstico neuropsicológico: entrevista clínica + pruebas originales + informe con recomendaciones. 2—4 sesiones presenciales en Quito.${booking}`;

  if (/(diagnostico psicolog)/.test(q))
    return `Diagnóstico Psicológico:\n🧠 Evalúo estado emocional, personalidad, relaciones, bullying, orientación vocacional y trastornos de conducta.\n📋 Pruebas originales y validadas.\n📄 Informe con recomendaciones. Presencial y online.${booking}`;

  if (/(terapia cognitiva|psicoterapia cognitiva|tcc|cognitivo|tecnicas)/.test(q))
    return `🗣️ La psicoterapia cognitiva identifica y modifica pensamientos que influyen en cómo te sientes y actúas. Trabajo con técnicas claras para generar cambios reales.\n\n✅ Comprender la conexión pensamiento--emoción--conducta${booking}`;

  if (/(pareja|matrimonio|relacion).*sesion|primera sesion pareja|terapia de pareja|pareja$/.test(q))
    return `💞 Si buscas terapia de pareja, puedo acompañarles para mejorar la comunicación y fijar metas claras. ¿Te gustaría agendar una cita?${booking}`;

  if (/(es igual|efectiv).*virtual|online.*presencial/.test(q))
    return `📡 Sí, la evidencia muestra eficacia similar entre terapia virtual y presencial.${booking}`;

  if (/(primera sesion|primera cita|que esperar|como es la primera)/.test(q))
    return `✨ En la primera sesión me cuentas lo que te preocupa y tus objetivos; te explico cómo trabajo y resolvemos dudas.${booking}`;

  if (/(peritaje|pericial)/.test(q))
    return `⚖️ Realizo peritajes psicológicos/neuropsicológicos con pruebas originales. Informes claros, precisos y sustentables en audiencia. ¿Deseas coordinar una primera cita?${booking}`;

  const askHowAnxiety =
    /(?:^| )(?:como|que|qué)\b.*\b(bajar|reducir|manejar|controlar)\b.*\bansiedad\b/.test(q) ||
    /\bansiedad\b.*\b(antes|previa|previo)\b/.test(q) ||
    /\bataque de panico\b/.test(q);
  if (askHowAnxiety)
    return `Puedo darte algo práctico para ahora mismo:\n• Respiración 4-7-8: inhala 4s, retén 7s, exhala 8s (x4—6 ciclos).\n• 5-4-3-2-1: 5 cosas que ves, 4 que sientes, 3 que oyes, 2 que hueles, 1 que saboreas.\n• Agua fría en muñecas/rostro 20—30s.\nSi te parece, lo trabajamos con más detalle en sesión.${booking}`;

  if (/(ansiedad|depresion|estres|triste|no puedo|angustia|ataque)/.test(q)) {
    const pide = /\b(como|que|qué|tips|consejo|antes|bajar|manejar|reducir|controlar)\b/.test(q);
    if (!pide && q.split(" ").length <= 12)
      return `Siento que estés pasando por esto 🫶. La terapia cognitiva puede darte herramientas claras para manejarlo.${booking}`;
  }

  if (/(agendar|reservar|cita|agenda|turno|zoom|presencial)/.test(q))
    return `¡Perfecto! Para agendar necesito: nombre, ciudad/país, modalidad (presencial/Zoom) y 2 opciones de día/horario.${booking}`;

  return null;
}

// ===== Handler =====
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Health check endpoint
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("OK - WhatsApp Bot is running", { 
        status: 200,
        headers: { "Content-Type": "text/plain" }
      });
    }

    if (request.method === "POST" && url.pathname === "/whatsapp") {
      try {
        console.log("=== NEW MESSAGE RECEIVED ===");
        
        const form = await request.formData();
        const Body = (form.get("Body") || "").trim();
        const From = form.get("From");
        const WaId = form.get("WaId") || From;
        const ProfileName = form.get("ProfileName") || "";
        const MessageSid = form.get("MessageSid") || form.get("SmsSid") || form.get("SmsMessageSid");
        const qNorm = normalize(Body);

        // Enhanced logging
        console.log("Message details:", { 
          From, 
          WaId, 
          Body: Body.substring(0, 100), // First 100 chars to avoid log spam
          MessageSid,
          ProfileName,
          timestamp: new Date().toISOString()
        });

        // Check if user is ignored
        if (isIgnored(env, From, WaId)) {
          console.log("User is ignored, no response sent:", { From, WaId });
          return new Response("", { status: 204 });
        }

        // Anti-duplicates - but with more logging
        if (alreadyProcessed(MessageSid)) {
          console.log("Duplicate message, skipping:", { MessageSid });
          return new Response("", { status: 204 });
        }

        // Check session state
        const currentSession = sessions.get(WaId);
        const hadHistory = (currentSession?.history?.length || 0) > 0;
        const isFirstMessage = !hadHistory;

        console.log("Session state:", {
          waId: WaId,
          hadHistory,
          isFirstMessage,
          sessionHistoryLength: currentSession?.history?.length || 0
        });

        // Check if asking for schedule/booking
        const asksSchedule = /(agendar|reservar|cita|agenda|turno|horario|disponibilidad|cuando puedes|zoom|presencial)/.test(qNorm);
        const showBooking = isFirstMessage || asksSchedule;

        console.log("Message analysis:", { asksSchedule, showBooking });

        // 1) Try FAQ first
        const quick = faq(Body, env, showBooking);
        if (quick) {
          console.log("FAQ response found, sending quick reply");
          pushMessage(WaId, "user", Body);
          pushMessage(WaId, "assistant", "[FAQ]");
          await sleep(Number(env.TYPING_MS_FAQ || "1200"));
          
          const response = new Response(xml(quick), { 
            headers: { "Content-Type": "application/xml" } 
          });
          console.log("FAQ response sent successfully");
          return response;
        }

        console.log("No FAQ match, proceeding to OpenAI");

        // 2) OpenAI API call
        pushMessage(WaId, "user", Body);
        const msgs = [
          { role: "system", content: SYS(env) },
          ...messagesForUser(WaId),
          { role: "system", content: `Número del usuario: ${From}. Nombre de perfil: ${ProfileName}` },
        ];

        console.log("Calling OpenAI with message count:", msgs.length);

        let reply;
        let openaiError = null;
        try {
          const openaiResponse = await withTimeout(
            fetch("https://api.openai.com/v1/chat/completions", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: env.OPENAI_MODEL || "gpt-4o-mini",
                temperature: 0.35,
                max_tokens: 150,
                top_p: 1,
                frequency_penalty: 0.2,
                presence_penalty: 0,
                messages: msgs
              })
            }),
            12000  // Increased timeout to 12 seconds
          );

          if (!openaiResponse.ok) {
            throw new Error(`OpenAI API error: ${openaiResponse.status} ${openaiResponse.statusText}`);
          }

          const j = await openaiResponse.json();
          reply = j?.choices?.[0]?.message?.content?.trim();
          console.log("OpenAI response received, length:", reply?.length || 0);

          if (!reply) {
            throw new Error("Empty response from OpenAI");
          }

        } catch (e) {
          openaiError = e?.message || e;
          console.log("OpenAI error:", openaiError);
        }

        // Fallback response if OpenAI fails
        if (!reply) {
          reply = 'Gracias por escribirme 🙌. Puedo ayudarte por Zoom o presencial en Cumbayá. ¿Prefieres agendar o resolver una duda primero?';
          console.log("Using fallback response due to OpenAI error:", openaiError);
        }

        // Remove specific times if not asking about scheduling
        const wantsSchedule = /(agendar|reservar|horario|hora|disponibilidad|turno)/.test(qNorm);
        if (!wantsSchedule) {
          reply = reply
            .replace(/\b(hoy|mañana|lunes|martes|miércoles|jueves|viernes|sábado|domingo)\b[^.\n]{0,60}?\b(\d{1,2}(:\d{2})?\s?(am|pm)?)\b/gi, "")
            .replace(/\s{2,}/g, " ")
            .trim();
        }

        // Add booking footer if needed
        if (showBooking) {
          reply += footer(env);
        }

        // Handle lead extraction
        const lead = extractLead(reply);
        const replyForUser = stripLead(reply);

        console.log("Final response prepared:", {
          hasLead: !!lead,
          responseLength: replyForUser.length,
          showsBooking: showBooking
        });

        // Save AI response to session
        pushMessage(WaId, "assistant", replyForUser);

        // Add typing delay
        await sleep(Number(env.TYPING_MS_AI || "1200"));
        
        const response = new Response(xml(replyForUser), { 
          headers: { "Content-Type": "application/xml" } 
        });

        // Notify admin about leads (asynchronous)
        if (lead && (env.ENABLE_ADMIN_NOTIFY || "").toLowerCase() === "true") {
          console.log("Lead detected, notifying admins");
          ctx.waitUntil(notifyAdmins(env, { From, lead }));
        }

        console.log("=== MESSAGE PROCESSED SUCCESSFULLY ===");
        return response;

      } catch (err) {
        console.error("Handler error:", err?.message || err);
        console.error("Error stack:", err?.stack);
        
        const safe = "Perdón, tuve un inconveniente técnico. ¿Puedes repetir tu mensaje o decirme si quieres agenda, precios u horarios?";
        return new Response(xml(safe), { 
          headers: { "Content-Type": "application/xml" } 
        });
      }
    }

    // Default response for other routes
    console.log("Unhandled request:", { method: request.method, path: url.pathname });
    return new Response("OK", { status: 200 });
  }
};

async function notifyAdmins(env, data) {
  try {
    const auth = "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
    const admins = (env.ADMIN_WHATSAPP || "").split(",").map(s => s.trim()).filter(Boolean);
    if (!admins.length) {
      console.log("No admin numbers configured");
      return;
    }

    const text =
      `🔥 Nuevo lead para ${env.CLINIC_NAME}\n` +
      `• Nombre: ${data.lead?.name || "—"}\n` +
      `• Motivo: ${data.lead?.reason || "—"}\n` +
      `• Ciudad: ${data.lead?.city || "—"}\n` +
      `• Horarios: ${(data.lead?.preferred_times || []).join(", ") || "—"}\n` +
      `• Modalidad: ${data.lead?.modality || "—"}\n` +
      `• Teléfono: ${data.lead?.phone || data.From || "—"}`;

    const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
    
    console.log(`Notifying ${admins.length} admin(s) about new lead`);
    
    await Promise.all(
      admins.map(async (To) => {
        try {
          const response = await fetch(url, {
            method: "POST",
            headers: { 
              Authorization: auth, 
              "Content-Type": "application/x-www-form-urlencoded" 
            },
            body: new URLSearchParams({ 
              From: env.TWILIO_WHATSAPP_FROM, 
              To, 
              Body: text 
            })
          });
          
          if (!response.ok) {
            console.error(`Failed to notify admin ${To}:`, response.status, response.statusText);
          } else {
            console.log(`Admin notification sent to ${To}`);
          }
        } catch (error) {
          console.error(`Error notifying admin ${To}:`, error.message);
        }
      })
    );
  } catch (error) {
    console.error("Error in notifyAdmins:", error.message);
  }
}