const cron = require("node-cron");
const moment = require("moment-timezone");
const axios = require("axios");
const Marina = require("../model/marinaModel");
const {
  createMarinaService,
  updateMarinaService,
} = require("../services/marinaService");

// Función que llama tu actor de Apify
async function fetchMarinasFromApify() {
  try {
    const res = await axios.get(process.env.APIFY_URL);
    console.log("Datos recibidos de Apify:", res);
    return res.data;
  } catch (error) {
    console.error("Error llamando Apify:", error);
    return [];
  }
}

const scrapeMarinasJob = () => {
  cron.schedule(
    "*/2 * * * *",
    async () => {
      console.log("Cron ejecutado:", moment().format());

      const marinas = await fetchMarinasFromApify();

      for (const m of marinas) {
        const exists = await Marina.findOne({ placeId: m.placeId });

        if (exists) {
          await updateMarinaService(m);
          console.log("Actualizada:", m.title);
        } else {
          await createMarinaService(m);
          console.log("Creada:", m.title);
        }
      }
    },
    { scheduled: true, timezone: "Europe/Madrid" }
  );
};

module.exports = scrapeMarinasJob;
