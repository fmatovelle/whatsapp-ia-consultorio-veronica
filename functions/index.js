// index.js — Firebase Functions Gen 2
require('dotenv').config();

const { onRequest } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const functions = require('firebase-functions'); // solo para functions.config() si no usas .env
const admin = require('firebase-admin');

admin.initializeApp();

// Ajusta la región si corresponde (p. ej. 'europe-west1')
setGlobalOptions({ region: 'europe-west1' });

const db = admin.firestore();

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

function pushMessage(waId, role, content) {
  return new Promise(function(resolve) {
    const sessionRef = db.collection('sessions').doc(waId);
    sessionRef.get().then(function(sessionDoc) {
      let history = [];
      if (sessionDoc.exists) {
        const data = sessionDoc.data();
        if (data && data.history) {
          history = data.history;
        }
      }

      history.push({ role: role, content: content, timestamp: admin.firestore.FieldValue.serverTimestamp() });
      if (history.length > 8) {
        history = history.slice(-8);
      }

      return sessionRef.set({
        history: history,
        lastUpdated: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }).then(function() {
      resolve();
    }).catch(function(error) {
      console.error('Error updating session:', error);
      resolve();
    });
  });
}

function messagesForUser(waId) {
  return new Promise(function(resolve) {
    const sessionRef = db.collection('sessions').doc(waId);
    sessionRef.get().then(function(sessionDoc) {
      if (sessionDoc.exists) {
        const data = sessionDoc.data();
        if (data && data.history) {
          resolve(data.history);
          return;
        }
      }
      resolve([]);
    }).catch(function(error) {
      console.error('Error getting messages:', error);
      resolve([]);
    });
  });
}

function alreadyProcessed(sid) {
  return new Promise(function(resolve) {
    if (!sid) {
      resolve(false);
      return;
    }

    const now = Date.now();
    const SID_TTL_MS = 5 * 60 * 1000;

    const oldEntriesQuery = db.collection('processedMessages').where('timestamp', '<', now - SID_TTL_MS);
    oldEntriesQuery.get().then(function(oldEntries) {
      const batch = db.batch();
      oldEntries.docs.forEach(function(doc) {
        batch.delete(doc.ref);
      });
      if (oldEntries.docs.length > 0) {
        return batch.commit();
      }
      return Promise.resolve();
    }).then(function() {
      const processedRef = db.collection('processedMessages').doc(sid);
      return processedRef.get();
    }).then(function(processedDoc) {
      if (processedDoc.exists) {
        console.log("Duplicate message detected: " + sid);
        resolve(true);
        return;
      }

      return db.collection('processedMessages').doc(sid).set({
        timestamp: now,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }).then(function() {
      resolve(false);
    }).catch(function(error) {
      console.error('Error checking processed messages:', error);
      resolve(false);
    });
  });
}

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

function SYS() {
  const clinicName = config.clinic && config.clinic.name ? config.clinic.name : "Consultorio";
  const clinicAddress = config.clinic && config.clinic.address ? config.clinic.address : "";
  const clinicPhone = config.clinic && config.clinic.phone ? config.clinic.phone : "";
  const clinicEmail = config.clinic && config.clinic.email ? config.clinic.email : "";
  const clinicHours = config.clinic && config.clinic.hours ? config.clinic.hours : "";
  const clinicServices = config.clinic && config.clinic.services ? config.clinic.services : "";
  const clinicPrices = config.clinic && config.clinic.prices ? config.clinic.prices : "";
  const emergencyDisclaimer = config.emergency && config.emergency.disclaimer ? config.emergency.disclaimer : "";

  return "Eres la psicóloga clínica Verónica (Consultorio: \"" + clinicName + "\", Quito — Hospital de los Valles, Cumbayá).\n" +
         "Responde SIEMPRE en primera persona, con calidez y brevedad (2—4 líneas). Usa emojis de forma natural y moderada.\n" +
         "Objetivo: resolver dudas y motivar a agendar una cita presencial u online por Zoom.\n\n" +
         "Datos:\n" +
         "• Dirección: " + clinicAddress + "\n" +
         "• Teléfono: " + clinicPhone + "\n" +
         "• Email: " + clinicEmail + "\n" +
         "• Horarios: " + clinicHours + "\n" +
         "• Servicios: " + clinicServices + "\n" +
         "• Precios: " + clinicPrices + "\n" +
         "• Emergencias: " + emergencyDisclaimer + "\n\n" +
         "Estilo: Cercano y empático; sin diagnósticos por chat.";
}

function extractLead(t) {
  if (!t) return null;
  const m = t.match(/LEAD:\s*(\{[\s\S]*\})/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (e) {
    return null;
  }
}

function stripLead(t) {
  if (!t) return "";
  const lines = t.split("\n");
  const filteredLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("LEAD:")) {
      filteredLines.push(lines[i]);
    }
  }
  return filteredLines.join("\n").trim();
}

function footer() {
  const bookingFooter = config.booking && config.booking.footer ? config.booking.footer : "";
  if (bookingFooter) return bookingFooter;

  const bookingLink = config.booking && config.booking.link ? config.booking.link : "";
  return "\n\n📅 Reserva aquí: " + bookingLink + "\n" +
         "🏠 Presencial 8:30—12:30 | 🌐 Online 14:30—18:30\n" +
         "🕐 Duración: 45 minutos | Frecuencia semanal";
}

function faq(raw, showBooking) {
  if (typeof showBooking === 'undefined') showBooking = false;

  const q = normalize(raw);
  const booking = showBooking ? footer() : "";

  if (/(emergencia|urgencia|suicid|autolesion|riesgo|crisis)/.test(q)) {
    const disclaimer = config.emergency && config.emergency.disclaimer ? config.emergency.disclaimer : "";
    return disclaimer;
  }

  if (/^(hola|buenas|buenos dias|buenas tardes|buenas noches|hi|hello)\b/.test(q)) {
    if (showBooking) {
      return "¡Hola! Soy Verónica, psicóloga clínica. Trabajo con psicoterapia cognitiva para ansiedad, depresión, conflictos, pareja y familia. ¿Te gustaría agendar una sesión presencial en Cumbayá o por Zoom?" + booking;
    } else {
      return "¡Hola! Soy Verónica, psicóloga clínica. ¿En qué te ayudo hoy?";
    }
  }

  if (/(precio|costo|tarifa|cuanto vale|cuanto cuesta)/.test(q)) {
    const prices = config.clinic && config.clinic.prices ? config.clinic.prices : "";
    return "Tarifas: " + prices + "\nLa sesión individual dura ~45—50 min; en pareja/familia se recomienda sesión doble." + booking;
  }

  if (/(horario|hora|disponibilidad|agenda|turno|cuando puedes)/.test(q)) {
    const hours = config.clinic && config.clinic.hours ? config.clinic.hours : "";
    return "Horarios: " + hours + "\n¿Te comparto disponibilidad por aquí o prefieres ver la agenda?" + booking;
  }

  if (/(direccion|donde|ubicacion|como llegar|mapa|maps|hospital de los valles|cumbaya)/.test(q)) {
    const address = config.clinic && config.clinic.address ? config.clinic.address : "";
    const phone = config.clinic && config.clinic.phone ? config.clinic.phone : "";
    const email = config.clinic && config.clinic.email ? config.clinic.email : "";
    return "Estoy en el Hospital de los Valles (Cumbayá). " + address + "\nTel: " + phone + " · Email: " + email + booking;
  }

  if (/(agendar|reservar|cita|agenda|turno|zoom|presencial)/.test(q)) {
    return "¡Perfecto! Para agendar necesito: nombre, ciudad/país, modalidad (presencial/Zoom) y 2 opciones de día/horario." + booking;
  }

  return null;
}

exports.whatsappWebhook = onRequest((req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST');
  res.set('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'GET') {
    res.status(200).send('OK - WhatsApp Bot is running on Firebase Functions');
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
  const qNorm = normalize(Body);

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

  alreadyProcessed(MessageSid).then(function(isDuplicate) {
    if (isDuplicate) {
      console.log("Duplicate message, skipping");
      res.status(204).send('');
      return;
    }

    return messagesForUser(WaId);
  }).then(function(currentHistory) {
    const hadHistory = currentHistory.length > 0;
    const isFirstMessage = !hadHistory;
    const asksSchedule = /(agendar|reservar|cita|agenda|turno|horario|disponibilidad|cuando puedes|zoom|presencial)/.test(qNorm);
    const showBooking = isFirstMessage || asksSchedule;

    console.log("Message analysis:", { asksSchedule: asksSchedule, showBooking: showBooking });

    const quick = faq(Body, showBooking);
    if (quick) {
      console.log("FAQ response found, sending quick reply");

      pushMessage(WaId, "user", Body).then(function() {
        return pushMessage(WaId, "assistant", "[FAQ]");
      }).then(function() {
        const typingDelay = config.typing && config.typing.ms_faq ? config.typing.ms_faq : "1200";
        return sleep(Number(typingDelay));
      }).then(function() {
        res.set('Content-Type', 'application/xml');
        res.status(200).send(xml(quick));
        console.log("FAQ response sent successfully");
      }).catch(function(error) {
        console.error("Error in FAQ flow:", error);
        res.set('Content-Type', 'application/xml');
        res.status(200).send(xml("Perdón, tuve un problema técnico. ¿Puedes repetir?"));
      });
      return;
    }

    console.log("No FAQ match, proceeding to OpenAI");

    pushMessage(WaId, "user", Body).then(function() {
      const msgs = [
        { role: "system", content: SYS() }
      ];

      for (let i = 0; i < currentHistory.length; i++) {
        msgs.push(currentHistory[i]);
      }

      msgs.push({ role: "system", content: "Número del usuario: " + From + ". Nombre de perfil: " + ProfileName });

      console.log("Calling OpenAI with message count:", msgs.length);

      const fetch = require('node-fetch');
      const apiKey = config.openai && config.openai.api_key ? config.openai.api_key : "";
      const model = config.openai && config.openai.model ? config.openai.model : "gpt-4o-mini";

      return withTimeout(
        fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + apiKey,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: model,
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
    }).then(function(openaiResponse) {
      if (!openaiResponse.ok) {
        throw new Error("OpenAI API error: " + openaiResponse.status + " " + openaiResponse.statusText);
      }
      return openaiResponse.json();
    }).then(function(j) {
      let reply;
      if (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) {
        reply = j.choices[0].message.content.trim();
      }

      if (!reply) {
        reply = 'Gracias por escribirme. Puedo ayudarte por Zoom o presencial en Cumbayá. ¿Prefieres agendar o resolver una duda primero?';
      }

      const wantsSchedule = /(agendar|reservar|horario|hora|disponibilidad|turno)/.test(qNorm);
      if (!wantsSchedule) {
        reply = reply.replace(/\b(hoy|mañana|lunes|martes|miércoles|jueves|viernes|sábado|domingo)\b[^.\n]{0,60}?\b(\d{1,2}(:\d{2})?\s?(am|pm)?)\b/gi, "")
                     .replace(/\s{2,}/g, " ")
                     .trim();
      }

      if (showBooking) {
        reply += footer();
      }

      const lead = extractLead(reply);
      const replyForUser = stripLead(reply);

      console.log("Final response prepared:", {
        hasLead: !!lead,
        responseLength: replyForUser.length,
        showsBooking: showBooking
      });

      return pushMessage(WaId, "assistant", replyForUser).then(function() {
        const aiTypingDelay = config.typing && config.typing.ms_ai ? config.typing.ms_ai : "1200";
        return sleep(Number(aiTypingDelay));
      }).then(function() {
        res.set('Content-Type', 'application/xml');
        res.status(200).send(xml(replyForUser));
        console.log("=== MESSAGE PROCESSED SUCCESSFULLY ===");
      });
    }).catch(function(err) {
      console.error("Handler error:", err && err.message ? err.message : err);
      const safe = "Perdón, tuve un inconveniente técnico. ¿Puedes repetir tu mensaje?";
      res.set('Content-Type', 'application/xml');
      res.status(200).send(xml(safe));
    });
  }).catch(function(err) {
    console.error("Handler error:", err && err.message ? err.message : err);
    const safe = "Perdón, tuve un inconveniente técnico. ¿Puedes repetir tu mensaje?";
    res.set('Content-Type', 'application/xml');
    res.status(200).send(xml(safe));
  });
});

exports.healthCheck = onRequest((req, res) => {
  res.status(200).send('OK - WhatsApp Bot is running on Firebase Functions');
});
