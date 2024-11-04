const cron = require("node-cron");
const Calendar = require("../model/calendarModel");

function sessionDeleteCronJob() {
  // Programar la tarea para que se ejecute diariamente a medianoche
  cron.schedule("0 0 * * *", async () => {
    try {
      // Calcular la fecha límite (hace un mes desde hoy)
      const dateLimit = new Date();
      dateLimit.setMonth(dateLimit.getMonth() - 1);

      // Buscar y eliminar sesiones anteriores a la fecha límite
      const deletedSessions = await Calendar.deleteMany({
        date: { $lt: dateLimit },
      });

      console.log(
        `Eliminadas ${deletedSessions.deletedCount} sesiones anteriores a ${dateLimit}`
      );
    } catch (error) {
      console.error("Error eliminando sesiones:", error);
    }
  });
}

module.exports = sessionDeleteCronJob;
