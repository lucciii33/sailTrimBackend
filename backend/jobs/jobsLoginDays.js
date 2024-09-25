const cron = require('node-cron');
const User = require('../model/userModel');
const moment = require('moment-timezone');
// cron.schedule('0 6 * * 1', async () => {
const resetLoginDaysJob = () => {
  cron.schedule('0 14 * * 3', async () => {
    const currentTime = moment.tz("Europe/Madrid").format('YYYY-MM-DD HH:mm:ss');
    console.log("Cron job ejecutado en (hora local):", currentTime);

    try {
      const updateResult = await User.updateMany({}, { 
        $set: {
          "loginDays.0": false,
          "loginDays.1": false,
          "loginDays.2": false,
          "loginDays.3": false,
          "loginDays.4": false,
          "loginDays.5": false,
          "loginDays.6": false,
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
};

module.exports = resetLoginDaysJob;  // Ahora estás exportando una función
