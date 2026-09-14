const express = require('express');
const qrcode = require('qrcode');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { GoogleGenerativeAI } = require('@google/generative-ai');

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
            browser: Browsers.ubuntu('Chrome') 
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                qrCodeUrl = await qrcode.toDataURL(qr);
            }

            if (connection === 'close') {
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                botReady = false;
                if (shouldReconnect) {
                    setTimeout(startBot, 3000); 
                }
            } else if (connection === 'open') {
                botReady = true;
                qrCodeUrl = null;
                console.log('✅ Bot WhatsApp se connect ho gaya hai!');
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
            const delay = (ms) => new Promise(res => setTimeout(res, ms));

            try {
                // 1. Padhne ka wait (Thoda late blue tick hoga)
                await delay(2000 + Math.random() * 2000);
                await sock.readMessages([m.key]);

                // 2. Typing start karna
                await delay(1000);
                await sock.sendPresenceUpdate('composing', remoteJid);

                // 3. AI Setup (Nayi aur stable library)
                const genAI = new GoogleGenerativeAI(geminiApiKey);
                const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

                // 4. Strict Human Prompt (Bilkul insaan banne ki warning)
                const context = isGroup ? "group chat" : "personal chat";
                const prompt = `Tum ek asli insaan (Indian) ho, tum koi AI ya chatbot nahi ho. 
                Tum apne doston ke sath WhatsApp par ${context} me baat kar rahe ho.
                
                Rules:
                1. Kabhi bhi mat bolna ki tum AI ho ya madad karne ke liye ho.
                2. Tumhara reply bahut chhota aur casual Hinglish mein hona chahiye (jaise log real mein chat karte hain).
                3. Agar koi "hello", "hi", "kya haal hai" bole, toh usko normal reply do (jaise: "haan bhai bol", "sab badiya tu bata", "kya hua?").
                4. Formal mat hona aur zyada punctuation (!, ?) ka use mat karna.
                
                Dost ka message: "${text}"
                Tumhara reply:`;
                
                const result = await model.generateContent(prompt);
                let replyText = result.response.text().trim();
                
                // Agar AI galti se quotes laga de to unhe hata dena
                replyText = replyText.replace(/^["']|["']$/g, '');

                // 5. Insaan jaisa typing delay
                const extraTypingTime = Math.min(replyText.length * 40, 4000); 
                await delay(extraTypingTime);

                // 6. Message bhej dena
                await sock.sendMessage(remoteJid, { text: replyText }, { quoted: m });
                
            } catch (e) {
                console.error('AI Error:', e);
            } finally {
                // 7. Kaam khatam hone par typing off
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
                <p style="color: red; font-size: 14px;">(Agar scan na ho to ek baar page refresh karke turant scan karein)</p>
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
    geminiApiKey = req.body.apikey;
    startBot(); 
    res.redirect('/');
});

app.post('/pair', async (req, res) => {
    const phone = req.body.phone.replace(/[^0-9]/g, '');
    try {
        if (!sock) return res.send("<center><h3>Bot start nahi hua, wapas jaakar API key daalein.</h3><a href='/'>Back</a></center>");
        
        const delay = (ms) => new Promise(res => setTimeout(res, ms));
        let code;
        
        try {
            await delay(1500); 
            code = await sock.requestPairingCode(phone);
        } catch (err) {
            if (err.message.includes('Closed') || err.message.includes('closed')) {
                startBot();
                await delay(4000); 
                code = await sock.requestPairingCode(phone);
            } else {
                throw err;
            }
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
        res.send(`<center><h3 style="color: red;">Error: ${err.message}</h3><p>Page refresh karke dobara try karein.</p><a href="/">Back</a></center>`);
    }
});

app.listen(port, () => console.log(`Server running on port ${port}`));
