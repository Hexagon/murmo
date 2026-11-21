// The offline screen (offline.html), in the language the app uses here, and back to the app once it can be reached.
// Standalone: the app's own modules are not stored, and this page must work without the server.

const TEXTS = {
  en: {
    title: "No connection",
    text: "Murmo opens only from its server, so that what runs here is always what the server serves. Your messages are still on this device, encrypted, and come back when the connection does.",
    retry: "Try again",
  },
  sv: {
    title: "Ingen anslutning",
    text: "Murmo öppnas bara från sin server, så att det som körs här alltid är det servern lämnar ut. Dina meddelanden finns kvar krypterade på den här enheten och kommer tillbaka när anslutningen gör det.",
    retry: "Försök igen",
  },
  de: {
    title: "Keine Verbindung",
    text: "Murmo öffnet sich nur von seinem Server, damit hier immer das läuft, was der Server ausliefert. Deine Nachrichten sind verschlüsselt auf diesem Gerät und kommen zurück, sobald die Verbindung wieder da ist.",
    retry: "Erneut versuchen",
  },
  es: {
    title: "Sin conexión",
    text: "Murmo solo se abre desde su servidor, para que lo que se ejecuta aquí sea siempre lo que entrega el servidor. Tus mensajes siguen cifrados en este dispositivo y vuelven cuando vuelva la conexión.",
    retry: "Reintentar",
  },
};

function language() {
  let chosen = null;
  try {
    chosen = localStorage.getItem("murmo-lang"); // the app's choice (i18n.js)
  } catch {
    // storage unavailable: the browser's languages
  }
  for (const tag of [chosen, ...(navigator.languages ?? [navigator.language])]) {
    const base = String(tag ?? "").toLowerCase().split("-")[0];
    if (base in TEXTS) return base;
  }
  return "en";
}

const lang = language();
document.documentElement.lang = lang;
for (const el of document.querySelectorAll("[data-t]")) el.textContent = TEXTS[lang][el.dataset.t];

const retry = () => location.reload();
document.getElementById("retry").addEventListener("click", retry);
addEventListener("online", retry);
