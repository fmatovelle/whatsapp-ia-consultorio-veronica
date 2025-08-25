const functions = require('firebase-functions');
const admin = require('firebase-admin');

// Initialize Firebase Admin
admin.initializeApp();

// Get Firestore instance for persistent storage
const db = admin.firestore();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const withTimeout = (p, ms) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("OPENAI_TIMEOUT")), ms))]);

const normalize = (s = "") =>
    s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();

const escapeXml = (s = "") =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const xml = (m) => `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(m || "")}</Message></Response>`;

// Session management using Firestore
async function pushMessage(waId, role, content) {
    try {
        const sessionRef = db.collection('sessions').doc(waId);
        const sessionDoc = await sessionRef.get();

        let history = [];
        if (sessionDoc.exists) {
            history = sessionDoc.data().history || [];
        }

        history.push({ role, content, timestamp: admin.firestore.FieldValue.serverTimestamp() });
        if (history.length > 8) history = history.slice(-8);

        await sessionRef.set({
            history,
            lastUpdated: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });

        console.log(`Session updated for ${waId}, history length: ${history.length}`);
    } catch (error) {
        console.error('Error updating session:', error);
    }
}

async function messagesForUser(waId) {
    try {
        const sessionRef = db.collection('sessions').doc(waId);
        const sessionDoc = await sessionRef.get();

        if (sessionDoc.exists) {
            return sessionDoc.data().history || [];
        }
        return [];
    } catch (error) {
        console.error('Error getting messages:', error);
        return [];
    }
}

// Duplicate message prevention using Firestore
async function alreadyProcessed(sid) {
    if (!sid) return false;

    try {
        const now = Date.now();
        const SID_TTL_MS = 5 * 60 * 1000;

        // Clean old entries
        const oldEntriesQuery = db.collection('processedMessages')
            .where('timestamp', '<', now - SID_TTL_MS);
        const oldEntries = await oldEntriesQuery.get();

        const batch = db.batch();
        oldEntries.docs.forEach(doc => batch.delete(doc.ref));
        if (oldEntries.docs.length > 0) {
            await batch.commit();
        }

        // Check if already processed
        const processedRef = db.collection('processedMessages').doc(sid);
        const processedDoc = await processedRef.get();

        if (processedDoc.exists) {
            console.log(`Duplicate message detected: ${sid}`);
            return true;
        }

        // Mark as processed
        await processedRef.set({
            timestamp: now,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return false;
    } catch (error) {
        console.error('Error checking processed messages:', error);
        return false;
    }
}

// Ignored numbers parsing
function parseIgnored() {
    const raw = (process.env.IGNORE_WHATSAPPS || "")
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

function isIgnored(from, waId) {
    const ig = parseIgnored();
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

// System prompt
const SYS = () => `
Eres la psicóloga clínica Verónica (Consultorio: "${process.env.CLINIC_NAME}", Quito — Hospital de los Valles, Cumbayá).
Responde SIEMPRE en primera persona, con calidez y brevedad (2—4 líneas). Usa emojis de forma natural y moderada (🌿✨🧠🤝😊).
Objetivo: resolver dudas y motivar a agendar una cita presencial u online por Zoom.

Datos:
• Dirección: ${process.env.CLINIC_ADDRESS}
• Teléfono: ${process.env.CLINIC_PHONE}
• Email: ${process.env.CLINIC_EMAIL}
• Horarios: ${process.env.CLINIC_HOURS}
• Servicios: ${process.env.CLINIC_SERVICES}
• Precios: ${process.env.CLINIC_PRICES}
• Emergencias: ${process.env.EMERGENCY_DISCLAIMER}

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

function footer() {
    const f = (process.env.BOOKING_FOOTER || "").replace(/\\n/g, "\n").trim();
    return f || (
        `\n\n📅 Reserva aquí: ${process.env.BOOKING_LINK}\n` +
        `🏠 Presencial 8:30—12:30 | 🌐 Online 14:30—18:30\n` +
        `🕐 Duración: 45 minutos | Frecuencia semanal\n` +
        `Si no ves un horario a tu medida, escríbeme y lo ajustamos.`
    );
}

// FAQs function
function faq(raw, showBooking = false) {
    const q = normalize(raw);
    const booking = showBooking ? footer() : "";

    if (/(emergencia|urgencia|suicid|autolesion|riesgo|crisis)/.test(q))
        return `${process.env.EMERGENCY_DISCLAIMER}`;

    // Saludo
    if (/^(hola|buenas|buenos dias|buenas tardes|buenas noches|hi|hello)\b/.test(q)) {
        return showBooking
            ? `¡Hola! Soy Verónica, psicóloga clínica. 🧠 Trabajo con psicoterapia cognitiva para ansiedad, depresión, conflictos, pareja y familia. ¿Te gustaría agendar una sesión presencial en Cumbayá o por Zoom?${booking}`
            : `¡Hola! Soy Verónica, psicóloga clínica. 🧠 ¿En qué te ayudo hoy?`;
    }

    if (/(precio|costo|tarifa|cuanto vale|cuanto cuesta)/.test(q))
        return `💳 Tarifas: ${process.env.CLINIC_PRICES}\n⏱️ La sesión individual dura ~45—50 min; en pareja/familia se recomienda sesión doble.${booking}`;

    if (/(horario|hora|disponibilidad|agenda|turno|cuando puedes)/.test(q))
        return `🗓️ Horarios: ${process.env.CLINIC_HOURS}\n¿Te comparto disponibilidad por aquí o prefieres ver la agenda?${booking}`;

    if (/(direccion|donde|ubicacion|como llegar|mapa|maps|hospital de los valles|cumbaya)/.test(q))
        return `📍 Estoy en el Hospital de los Valles (Cumbayá). ${process.env.CLINIC_ADDRESS}\nTel: ${process.env.CLINIC_PHONE} · Email: ${process.env.CLINIC_EMAIL}${booking}`;

    if (/(quien eres|tu experiencia|sobre ti|sobre usted|conocerte|perfil|trayectoria)/.test(q))
        return `✨ Soy psicóloga clínica especializada en psicoterapia cognitiva (Albert Ellis Institute — NY) con más de 28 años de experiencia. Acompaño a adolescentes y adultos; también realizo formación clínica y peritajes. Atiendo en Quito y por Zoom 🌐.${booking}`;

    if (/(estimula|rehabilita).*cognit|neuronup/.test(q))
        return `🧠 Estimulación y Rehabilitación Cognitiva: atención, memoria, lenguaje, razonamiento y funciones ejecutivas. Uso NeuronUP, Decedario PRO y planes personalizados.${booking}`;

    if (/(diagnostico neuropsicolog|neuropsicol)/.test(q))
        return `🧠 Diagnóstico neuropsicológico: entrevista clínica + pruebas originales + informe con recomendaciones. 2—4 sesiones presenciales en Quito.${booking}`;

    if (/(diagnostico psicolog)/.test(q))
        return `Diagnóstico Psicológico:\n🧠 Evalúo estado emocional, personalidad, relaciones, bullying, orientación vocacional y trastornos de conducta.\n📋 Pruebas originales y validadas.\n📄 Informe con recomendaciones. Presencial y online.${booking}`;

    if (/(terapia cognitiva|psicoterapia cognitiva|tcc|cognitivo)/.test(q))
        return `🗣️ La psicoterapia cognitiva identifica y modifica pensamientos que influyen en cómo te sientes y actúas. Trabajo con técnicas claras para generar cambios reales.${booking}`;

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

// Admin notification function
async function notifyAdmins(data) {
    try {
        const auth = "Basic " + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
        const admins = (process.env.ADMIN_WHATSAPP || "").split(",").map(s => s.trim()).filter(Boolean);
        if (!admins.length) {
            console.log("No admin numbers configured");
            return;
        }

        const text =
            `🔥 Nuevo lead para ${process.env.CLINIC_NAME}\n` +
            `• Nombre: ${data.lead?.name || "—"}\n` +
            `• Motivo: ${data.lead?.reason || "—"}\n` +
            `• Ciudad: ${data.lead?.city || "—"}\n` +
            `• Horarios: ${(data.lead?.preferred_times || []).join(", ") || "—"}\n` +
            `• Modalidad: ${data.lead?.modality || "—"}\n` +
            `• Teléfono: ${data.lead?.phone || data.From || "—"}`;

        const url = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`;

        console.log(`Notifying ${admins.length} admin(s) about new lead`);

        await Promise.all(
            admins.map(async (To) => {
                try {
                    const fetch = require('node-fetch');
                    const response = await fetch(url, {
                        method: "POST",
                        headers: {
                            Authorization: auth,
                            "Content-Type": "application/x-www-form-urlencoded"
                        },
                        body: new URLSearchParams({
                            From: process.env.TWILIO_WHATSAPP_FROM,
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

// Main webhook handler
const whatsappWebhook = functions.https.onRequest(async (req, res) => {
    // CORS headers
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST');
    res.set('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'GET') {
        res.status(200).send('OK - WhatsApp Bot is running on Firebase Functions');
        return;
    }

    if (req.method === 'POST') {
        try {
            console.log("=== NEW MESSAGE RECEIVED ===");

            const Body = (req.body.Body || "").trim();
            const From = req.body.From;
            const WaId = req.body.WaId || From;
            const ProfileName = req.body.ProfileName || "";
            const MessageSid = req.body.MessageSid || req.body.SmsSid || req.body.SmsMessageSid;
            const qNorm = normalize(Body);

            // Enhanced logging
            console.log("Message details:", {
                From,
                WaId,
                Body: Body.substring(0, 100),
                MessageSid,
                ProfileName,
                timestamp: new Date().toISOString()
            });

            // Check if user is ignored
            if (isIgnored(From, WaId)) {
                console.log("User is ignored, no response sent:", { From, WaId });
                res.status(204).send('');
                return;
            }

            // Anti-duplicates
            if (await alreadyProcessed(MessageSid)) {
                console.log("Duplicate message, skipping:", { MessageSid });
                res.status(204).send('');
                return;
            }

            // Check session state
            const currentHistory = await messagesForUser(WaId);
            const hadHistory = currentHistory.length > 0;
            const isFirstMessage = !hadHistory;

            console.log("Session state:", {
                waId: WaId,
                hadHistory,
                isFirstMessage,
                sessionHistoryLength: currentHistory.length
            });

            // Check if asking for schedule/booking
            const asksSchedule = /(agendar|reservar|cita|agenda|turno|horario|disponibilidad|cuando puedes|zoom|presencial)/.test(qNorm);
            const showBooking = isFirstMessage || asksSchedule;

            console.log("Message analysis:", { asksSchedule, showBooking });

            // 1) Try FAQ first
            const quick = faq(Body, showBooking);
            if (quick) {
                console.log("FAQ response found, sending quick reply");
                await pushMessage(WaId, "user", Body);
                await pushMessage(WaId, "assistant", "[FAQ]");
                await sleep(Number(process.env.TYPING_MS_FAQ || "1200"));

                res.set('Content-Type', 'application/xml');
                res.status(200).send(xml(quick));
                console.log("FAQ response sent successfully");
                return;
            }

            console.log("No FAQ match, proceeding to OpenAI");

            // 2) OpenAI API call
            await pushMessage(WaId, "user", Body);
            const msgs = [
                { role: "system", content: SYS() },
                ...currentHistory,
                { role: "system", content: `Número del usuario: ${From}. Nombre de perfil: ${ProfileName}` },
            ];

            console.log("Calling OpenAI with message count:", msgs.length);

            let reply;
            let openaiError = null;
            try {
                const fetch = require('node-fetch');
                const openaiResponse = await withTimeout(
                    fetch("https://api.openai.com/v1/chat/completions", {
                        method: "POST",
                        headers: {
                            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
                            "Content-Type": "application/json",
                        },
                        body: JSON.stringify({
                            model: process.env.OPENAI_MODEL || "gpt-4o-mini",
                            temperature: 0.35,
                            max_tokens: 150,
                            top_p: 1,
                            frequency_penalty: 0.2,
                            presence_penalty: 0,
                            messages: msgs
                        })
                    }),
                    12000
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
                reply += footer();
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
            await pushMessage(WaId, "assistant", replyForUser);

            // Add typing delay
            await sleep(Number(process.env.TYPING_MS_AI || "1200"));

            res.set('Content-Type', 'application/xml');
            res.status(200).send(xml(replyForUser));

            // Notify admin about leads (asynchronous)
            if (lead && (process.env.ENABLE_ADMIN_NOTIFY || "").toLowerCase() === "true") {
                console.log("Lead detected, notifying admins");
                // Firebase Functions handle async operations differently
                notifyAdmins({ From, lead }).catch(console.error);
            }

            console.log("=== MESSAGE PROCESSED SUCCESSFULLY ===");

        } catch (err) {
            console.error("Handler error:", err?.message || err);
            console.error("Error stack:", err?.stack);

            const safe = "Perdón, tuve un inconveniente técnico. ¿Puedes repetir tu mensaje o decirme si quieres agenda, precios u horarios?";
            res.set('Content-Type', 'application/xml');
            res.status(200).send(xml(safe));
        }
    } else {
        res.status(405).send('Method Not Allowed');
    }
});

// Health check function
const healthCheck = functions.https.onRequest((req, res) => {
    res.status(200).send('OK - WhatsApp Bot is running on Firebase Functions');
});

module.exports = {
    whatsappWebhook,
    healthCheck
};