const express = require("express");
const colors = require("colors");
const dotenv = require("dotenv").config();
const port = process.env.PORT || 5000;
const { errorHandler } = require("./middleware/errorMiddleware");
const connectDB = require("./config/db");
const resetLoginDaysJob = require("./jobs/jobsLoginDays"); // Ruta al cron job
const sessionDeleteCronJob = require("./jobs/deleteSession.js");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const Mailjet = require("node-mailjet"); // Para enviar correos
const User = require("./model/userModel.js");
const bodyParser = require("body-parser");

const mailjet = Mailjet.apiConnect(
  process.env.MJ_APIKEY_PUBLIC,
  process.env.MJ_APIKEY_PRIVATE
);

connectDB();

const app = express();

app.post(
  "/webhookFailPayments",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;
    console.log("event", event);

    try {
      // Verificar que el evento venga de Stripe usando la clave del webhook (Webhook Signing Secret)
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      console.error("⚠️ Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "payment_intent.requires_action") {
      const paymentIntent = event.data.object;
      const customerId = paymentIntent.customer;

      // Buscar al usuario en la base de datos
      const user = await User.findOne({ customerIdStripe: customerId });

      if (user) {
        // Guardar el `client_secret` en el campo `secretKeyStripe` del usuario
        user.secretKeyStripe = paymentIntent.client_secret;
        await user.save();

        const request = mailjet.post("send", { version: "v3.1" }).request({
          Messages: [
            {
              From: {
                Email: "novaappai@gmail.com", // Cambia a tu correo
                Name: "NOVA AI", // Nombre que aparecerá como remitente
              },
              To: [
                {
                  Email: user.email, // Email del usuario (se obtiene desde la base de datos)
                  Name: `${user.firstName} ${user.lastName}`, // Nombre completo del usuario
                },
              ],
              Subject:
                "Atención: Tu banco necesita confirmar este pago!!!!!!!!!!",
              TextPart: `Hola ${user.firstName}, el pago de tu suscripción falló. Tu banco necesita una autorizacion para procesar este pago`,
              HTMLPart: `
              <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px; background-color: #F7F7F7;">
                <h3 style="color: #FF4C4C; margin-bottom: 10px;">Hola ${user.firstName},</h3>
                <img src="https://bluenova.s3.us-east-2.amazonaws.com/Cara-Sad-Logout.png" alt="Imagen de pago fallido" style="width: 80%; max-width: 400px; height: auto; border-radius: 10px; margin-bottom: 20px;"/>
                <p style="font-size: 18px; color: #333; margin-bottom: 20px;">
                    Hola ${user.firstName}, el pago de tu suscripción falló. Tu banco necesita una autorizacion para procesar este pago, tienes 24 horas para poder aturoizarte.
                </p>
                <p style="font-size: 16px; color: #007BFF; margin-bottom: 20px;">
                   <a href="https://mentorai.netlify.app/" style="text-decoration: none; color: #007BFF; font-weight: bold;">Haz clic aquí para actualizar tu método de pago</a>
                </p>
                <p style="font-size: 14px; color: #555; margin-top: 20px;">
                    Si necesitas ayuda o tienes alguna pregunta, no dudes en contactarnos. Estamos aquí para asistirte.
                </p>
                <p style="font-size: 14px; color: #777; margin-top: 20px;">
                    Saludos,<br/>
                    <strong>El equipo de NOVA AI</strong>
                </p>
            </div>
                `,
            },
          ],
        });

        // Manejo de la respuesta del envío de email
        request
          .then((result) => {
            console.log("Correo enviado exitosamente:", result.body);
          })
          .catch((err) => {
            console.error("Error al enviar el correo:", err.statusCode);
          });

        // Notificar al frontend que se requiere 3D Secure
        return res.json({
          message: "3D Secure required",
          clientSecret: paymentIntent.client_secret, // Envías el `client_secret` al frontend
        });
      }
    }

    // Manejar el evento de pago fallido
    if (event.type === "invoice.payment_failed") {
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
                  Email: "novaappai@gmail.com", // Cambia a tu correo
                  Name: "NOVA AI", // Nombre que aparecerá como remitente
                },
                To: [
                  {
                    Email: user.email, // Email del usuario (se obtiene desde la base de datos)
                    Name: `${user.firstName} ${user.lastName}`, // Nombre completo del usuario
                  },
                ],
                Subject:
                  "Atención: Hubo un problema con el pago de tu suscripción",
                TextPart: `Hola ${user.firstName}, el pago de tu suscripción falló. Por favor, actualiza tu método de pago.`,
                HTMLPart: `
                <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px; background-color: #F7F7F7;">
                  <h3 style="color: #FF4C4C; margin-bottom: 10px;">Hola ${user.firstName},</h3>
                  <img src="https://bluenova.s3.us-east-2.amazonaws.com/Cara-Sad-Logout.png" alt="Imagen de pago fallido" style="width: 80%; max-width: 400px; height: auto; border-radius: 10px; margin-bottom: 20px;"/>
                  <p style="font-size: 18px; color: #333; margin-bottom: 20px;">
                      El pago de tu suscripción ha fallado. Para evitar interrupciones en tu acceso, te recomendamos <strong>actualizar tu método de pago</strong> lo antes posible.
                  </p>
                  <p style="font-size: 16px; color: #007BFF; margin-bottom: 20px;">
                      <a href="https://mentorai.netlify.app/checkoutUpdate" style="text-decoration: none; color: #007BFF; font-weight: bold;">Haz clic aquí para actualizar tu método de pago</a>
                  </p>
                  <p style="font-size: 14px; color: #555; margin-top: 20px;">
                      Si necesitas ayuda o tienes alguna pregunta, no dudes en contactarnos. Estamos aquí para asistirte.
                  </p>
                  <p style="font-size: 14px; color: #777; margin-top: 20px;">
                      Saludos,<br/>
                      <strong>El equipo de NOVA AI</strong>
                  </p>
              </div>
                  `,
              },
            ],
          });

          // Manejo de la respuesta del envío de email
          request
            .then((result) => {
              console.log("Correo enviado exitosamente:", result.body);
            })
            .catch((err) => {
              console.error("Error al enviar el correo:", err.statusCode);
            });
        } else {
          console.log("Usuario no encontrado para el customerId:", customerId);
        }
      } catch (error) {
        console.error("Error buscando usuario o enviando correo:", error);
      }
    } else if (event.type === "invoice.payment_succeeded") {
      const invoice = event.data.object;
      const customerId = invoice.customer;

      try {
        // Buscar al usuario en la base de datos con su customerId de Stripe
        const user = await User.findOne({ customerIdStripe: customerId });

        if (user) {
          // Enviar correo al usuario notificando que su pago fue exitoso
          user.secretKeyStripe = null;
          await user.save();
          const request = mailjet.post("send", { version: "v3.1" }).request({
            Messages: [
              {
                From: {
                  Email: "bluelighttech22@gmail.com", // Cambia a tu correo
                  Name: "Blue Light Tech", // Nombre que aparecerá como remitente
                },
                To: [
                  {
                    Email: user.email, // Email del usuario (se obtiene desde la base de datos)
                    Name: `${user.firstName} ${user.lastName}`, // Nombre completo del usuario
                  },
                ],
                Subject: "¡Pago exitoso de tu suscripción!",
                TextPart: `Hola ${user.firstName}, el pago de tu suscripción se procesó correctamente.`,
                HTMLPart: `
                          <h3>Hola ${user.firstName},</h3>
                          <img src="https://bluenova.s3.us-east-2.amazonaws.com/Cara-Sad-Login.png" alt="Nova te da la bienvenida" style="width: 100%; max-width: 400px; height: auto; border-radius: 10px; margin-bottom: 20px;"/>
                          <p>El pago de tu suscripción se procesó correctamente.</p>
                          <p style="font-size: 14px; color: #666666; margin-top: 20px;">
                            Un saludo,<br/>
                            <strong>El equipo de NOVA AI</strong>
                        </p>
                        `,
              },
            ],
          });

          request
            .then((result) => {
              console.log("Correo enviado exitosamente:", result.body);
            })
            .catch((err) => {
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
  }
);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cors());

const endpointSecret = process.env.WEB_HOOK_STRIPE;

// app.use('/api/meditations', require('./routes/meditationRoutes'))
app.use("/api/white_noise", require("./routes/whiteNoseRoutes"));
app.use("/api/user", require("./routes/userRoutes"));
app.use("/api/ai", require("./routes/dashboardRoutes"));
app.use("/api/pomodoro", require("./routes/pomodoroRoutes"));
app.use("/api/checkout", require("./routes/checkoutRoutes"));
app.use("/api/motivationalNotes", require("./routes/notesRoutes"));
app.use("/api/resume", require("./routes/resumeRoutes"));
app.use("/api/apuntes", require("./routes/apuntesRoutes"));
app.use("/api/quizes", require("./routes/quizesRoutes.js"));
app.use("/api/calendar", require("./routes/calendarRoutes.js"));
app.use("/api/report", require("./routes/reportController.js"));
app.use("/api/mapasMentales", require("./routes/mapaMentalRoutes.js"));

app.use(errorHandler);

app.listen(port, () => console.log(`Server started on port ${port}`));

resetLoginDaysJob();
sessionDeleteCronJob();
