const express = require('express')
const colors = require('colors')
const dotenv = require('dotenv').config()
const port = process.env.PORT || 5000
const {errorHandler} = require('./middleware/errorMiddleware')
const connectDB = require('./config/db')
const resetLoginDaysJob = require('./jobs/jobsLoginDays'); // Ruta al cron job
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Mailjet = require("node-mailjet");  // Para enviar correos
const User = require('./model/userModel.js');
const bodyParser = require('body-parser');

const mailjet = Mailjet.apiConnect(process.env.MJ_APIKEY_PUBLIC, process.env.MJ_APIKEY_PRIVATE);

connectDB()

const app = express()

app.post('/webhookFailPayments', express.raw({ type: 'application/json' }), async(req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    console.log("event", event)
  
    try {
      // Verificar que el evento venga de Stripe usando la clave del webhook (Webhook Signing Secret)
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      console.error('⚠️ Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  
    // Manejar el evento de pago fallido
    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      const customerId = invoice.customer;
  
      try {
        // Buscar al usuario en la base de datos con su customerId de Stripe
        const user = await User.findOne({ customerIdStripe: customerId });
  
        if (user) {
          // Enviar correo al usuario notificando que su pago falló
          const request = mailjet.post("send", { version: "v3.1" }).request({
            Messages: [
              {
                From: {
                  Email: "bluelighttech22@gmail.com",  // Cambia a tu correo
                  Name: "Blue Light Tech",  // Nombre que aparecerá como remitente
                },
                To: [
                  {
                    Email: user.email,  // Email del usuario (se obtiene desde la base de datos)
                    Name: `${user.firstName} ${user.lastName}`,  // Nombre completo del usuario
                  },
                ],
                Subject: "Problema con el pago de tu suscripción",
                TextPart: `Hola ${user.firstName}, el pago de tu suscripción falló. Por favor, actualiza tu método de pago.`,
                HTMLPart: `<h3>Hola ${user.firstName},</h3>
                  <p>El pago de tu suscripción falló. Por favor, <a href="https://billing.stripe.com/p/update_payment/YOUR_LINK">actualiza tu método de pago aquí</a>.</p>`,
              },
            ],
          });
  
          // Manejo de la respuesta del envío de email
          request
            .then(result => {
              console.log("Correo enviado exitosamente:", result.body);
            })
            .catch(err => {
              console.error("Error al enviar el correo:", err.statusCode);
            });
        } else {
          console.log("Usuario no encontrado para el customerId:", customerId);
        }
      } catch (error) {
        console.error("Error buscando usuario o enviando correo:", error);
      }
    }
  
    // Responder a Stripe que el evento fue recibido correctamente
    res.status(200).json({ received: true });
});

app.use(express.json())
app.use(express.urlencoded({extended: false}))
app.use(cors());

const endpointSecret = process.env.WEB_HOOK_STRIPE;

// app.use('/webhookFailPayments', bodyParser.raw({type: 'application/json'}));

// app.post('/webhookFailPayments', express.raw({ type: 'application/json' }), (req, res) => {
//     const sig = req.headers['stripe-signature'];

//     let event;

//     try {
//         event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
//     } catch (err) {
//         console.error(`⚠️ Webhook signature verification failed:`, err.message);
//         return res.status(400).send(`Webhook Error: ${err.message}`);
//     }

//     // Verificar el tipo de evento
//     if (event.type === 'invoice.payment_failed') {
//         console.log('⚠️ Evento de pago fallido recibido');
//         // Tu lógica para manejar el pago fallido
//     }

//     res.status(200).json({ received: true });
// });



// app.post('/webhookFailPayments', async (req, res) => {
//     console.log("🔔 Webhook recibido"); // Log inicial para verificar que Stripe envió algo
//     const sig = req.headers['stripe-signature'];
//     let event;
  
//     try {
//       event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
//       console.log("✅ Webhook tipo:", event.type); // Log para ver qué tipo de evento llegó
//     } catch (err) {
//       console.error('⚠️ Webhook signature verification failed:', err.message);
//       return res.status(400).send(`Webhook Error: ${err.message}`);
//     }
  
//     if (event.type === 'invoice.payment_failed') {
//       console.log("⚠️ Evento de pago fallido recibido");
//     }
  
//     res.status(200).json({ received: true });
//   });


// app.use('/api/meditations', require('./routes/meditationRoutes'))
app.use('/api/white_noise', require('./routes/whiteNoseRoutes'))
app.use('/api/user', require('./routes/userRoutes'))
app.use('/api/ai', require("./routes/dashboardRoutes"))
app.use('/api/pomodoro', require("./routes/pomodoroRoutes"))
app.use('/api/checkout', require("./routes/checkoutRoutes"))
app.use('/api/motivationalNotes', require("./routes/notesRoutes"))
app.use('/api/resume', require("./routes/resumeRoutes"))

app.use(errorHandler)

app.listen(port, ()=> console.log(`Server started on port ${port}`))

resetLoginDaysJob();
console.log("funcion se envio")