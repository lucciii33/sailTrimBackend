const cron = require('node-cron');
const User = require('../model/userModel');
const moment = require('moment-timezone');

// Programar un trabajo para que se ejecute cada domingo a la medianoche en la zona horaria "Europe/Madrid"
cron.schedule('0 6 * * 1', async () => {
  const currentTime = moment.tz("Europe/Madrid").format('YYYY-MM-DD HH:mm:ss');
  console.log("Cron job ejecutado en (hora local):", currentTime);

  try {
    // Reiniciar los días de login de todos los usuarios
    const updateResult = await User.updateMany({}, { 
      $set: {
        "loginDays.0": false,
        "loginDays.1": false,
        "loginDays.2": false,
        "loginDays.3": false,
        "loginDays.4": false,
        "loginDays.5": false,
        "loginDays.6": false,
        lastWeekNumber: Math.floor(Date.now() / (1000 * 60 * 60 * 24 * 7)) // Actualiza el número de semana
      }
    });

    console.log(`Se han reiniciado los días de login para todos los usuarios. Documentos modificados: ${updateResult.nModified}`);
  } catch (error) {
    console.error("Error reiniciando los días de login:", error);
  }

}, {
  scheduled: true,
  timezone: "Europe/Madrid"
});
