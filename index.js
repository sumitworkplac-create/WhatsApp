const express = require('express');
const qrcode = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs'); // Files delete karne ke liye zaroori

const app = express();
app.use(express.urlencoded({ extended: true }));
const port = process.env.PORT || 3000;

let geminiApiKey = null;
let qrCodeUrl = null;
let botReady = false;
let sock = null;

async function startBot() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState('auth_info');
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            auth: state,
            // Yahan browser setting update ki hai taaki pairing code hamesha generate ho
            browser: ['Ubuntu', 'Chrome', '110.0.5481.192'] 
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            if (qr) qrCodeUrl = await qrcode.toDataURL(qr);
            
            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                botReady = false;
                
                if (shouldReconnect) {
                    setTimeout(startBot, 3000); 
                } else {
                    // Agar logout ho jaye to purani file delete kar do
                    fs.rmSync('./auth_info', { recursive: true, force: true });
                }
            } else if (connection === 'open') {
                botReady = true;
                qrCodeUrl = null;
                console.log('✅ Bot WhatsApp se connect ho gaya!');
            }
        });

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;
            const m = messages[0];
            
            if (!m.message || m.key.fromMe || !geminiApiKey) return;

            const text = m.message.conversation || m.message.extendedTextMessage?.text;
            if (!text) return;

            const remoteJid = m.key.remoteJid;
            const isGroup = remoteJid.includes('@g.us');

            try {
                // 1. Padhne ka natak aur Blue Tick
                await new Promise(r => setTimeout(r, 2000));
                await sock.readMessages([m.key]);

                // 🛠️ PING TEST: Check karne ke liye bot chal raha hai ya nahi
                if (text.toLowerCase() === '!ping') {
                    await sock.sendMessage(remoteJid, { text: 'Pong! 🟢 Bot ekdum mast chal raha hai.' }, { quoted: m });
                    return;
                }

                // 2. Typing start karna
                await sock.sendPresenceUpdate('composing', remoteJid);
                
                let replyText = "";
                try {
                    const genAI = new GoogleGenerativeAI(geminiApiKey);
                    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
                    
                    const prompt = `Tum ek asli Indian insaan ho. Dost ka message: "${text}". Ek chhota, natural, aur casual Hinglish reply do (jaise "haan bhai", "kya chal raha hai"). Kabhi mat bolna ki tum AI ho.`;
                    
                    const result = await model.generateContent(prompt);
                    replyText = result.response.text().trim().replace(/^["']|["']$/g, '');
                } catch (aiError) {
                    console.error('AI Error:', aiError);
                    replyText = "⚠️ Gemini API Error: API key check kar bhai, kaam nahi kar rahi hai.";
                }

                // 3. Message bhejna
                await new Promise(r => setTimeout(r, 2000));
                await sock.sendMessage(remoteJid, { text: replyText }, { quoted: m });
                
            } catch (e) {
                console.error('WhatsApp Error:', e);
            } finally {
                await sock.sendPresenceUpdate('paused', remoteJid);
            }
        });
    } catch (error) {
        console.error("Bot Start Error:", error);
    }
}

// --- UI ROUTING ---
app.get('/', (req, res) => {
    if (!geminiApiKey) {
        return res.send(`
            <div style="text-align: center; font-family: sans-serif; margin-top: 50px;">
                <h2>Setup: Gemini API Key Daalein</h2>
                <form action="/save-api" method="POST">
                    <input type="password" name="apikey" placeholder="Paste Gemini API Key here" required style="padding: 10px; width: 300px;">
                    <button type="submit" style="padding: 10px; background: #007bff; color: white; border: none; cursor: pointer;">Save & Start</button>
                </form>
            </div>
        `);
    }

    if (botReady) {
        return res.send("<h2 style='color: green; text-align: center; margin-top:50px;'>✅ Bot successfully connect ho gaya hai aur chal raha hai!</h2>");
    }

    res.send(`
        <div style="text-align: center; font-family: sans-serif; margin-top: 50px;">
            <p style="color: green;">API Key Saved! 🔒</p>
            ${qrCodeUrl ? `
                <h2>Option 1: QR Scan Karein</h2>
                <img src="${qrCodeUrl}" style="width: 250px; height: 250px;" />
            ` : '<h3>System Loading... 5 seconds mein refresh karein</h3>'}
            <hr style="margin: 30px 0;">
            <h2>Option 2: Number se Pair Karein</h2>
            <form action="/pair" method="POST">
                <input type="text" name="phone" placeholder="919876543210 (Country code lagayein)" required style="padding: 10px; width: 250px;">
                <button type="submit" style="padding: 10px; background: #25D366; color: white; border: none; cursor: pointer;">Get Code</button>
            </form>
        </div>
    `);
});

app.post('/save-api', (req, res) => {
    geminiApiKey = req.body.apikey.trim();
    startBot(); 
    res.redirect('/');
});

app.post('/pair', async (req, res) => {
    const phone = req.body.phone.replace(/[^0-9]/g, '');
    try {
        // YEH HAI FIX: Agar connection timeout ho gaya ho, toh fresh restart karke code mangega
        if (!sock || !qrCodeUrl) {
            startBot();
            await new Promise(r => setTimeout(r, 3000));
        }
        
        let code;
        try {
            code = await sock.requestPairingCode(phone);
        } catch (err) {
            // Ek aur retry chance
            startBot();
            await new Promise(r => setTimeout(r, 4000));
            code = await sock.requestPairingCode(phone);
        }
        
        const formattedCode = code.match(/.{1,4}/g).join('-');
        
        res.send(`
            <div style="text-align: center; margin-top: 50px; font-family: sans-serif;">
                <h2>Aapka WhatsApp Pairing Code:</h2>
                <h1 style="color: #25D366; letter-spacing: 5px; font-size: 40px;">${formattedCode}</h1>
                <p>Apne WhatsApp me "Linked Devices" -> "Link with phone number" par click karein aur ye code daalein.</p>
                <br>
                <a href="/" style="padding: 10px; background: #007bff; color: white; text-decoration: none; border-radius: 5px;">Go Back & Check Status</a>
            </div>
        `);
    } catch (err) {
        res.send(`<center><h3 style="color: red;">Error: System Timeout. Page refresh karke dobara number daalein.</h3><a href="/">Back</a></center>`);
    }
});

app.listen(port, () => console.log(`Server running on port ${port}`));
