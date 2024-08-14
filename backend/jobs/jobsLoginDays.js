const cron = require('node-cron');
const User = require('../model/userModel'); // Ruta al modelo de usuario

// Programar un trabajo para que se ejecute cada domingo a la medianoche
cron.schedule('0 0 * * 0', async () => {
  console.log("Cron job ejecutado en:", new Date().toLocaleString("es-ES", { timeZone: "Europe/Madrid" }));
  try {
    await User.updateMany({}, { 
      loginDays: {
        "0": false,
        "1": false,
        "2": false,
        "3": false,
        "4": false,
        "5": false,
        "6": false
      }
    });
    console.log("Se han reiniciado los días de login para todos los usuarios.");
  } catch (error) {
    console.error("Error reiniciando los días de login:", error);
  }
}, {
  scheduled: true,
  timezone: "Europe/Madrid" // Configuración de la zona horaria
});

module.exports = cron;
