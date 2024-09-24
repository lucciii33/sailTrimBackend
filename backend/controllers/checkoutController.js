const asyncHanlder = require("express-async-handler");
const express = require("express");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
console.log("stripe", stripe);
console.log("process.env.STRIPE_SECRET_KEY", process.env.STRIPE_SECRET_KEY);
const User = require("../model/userModel");
const Mailjet = require("node-mailjet");

const mailjet = Mailjet.apiConnect(
  process.env.MJ_APIKEY_PUBLIC,
  process.env.MJ_APIKEY_PRIVATE
);

// const payment = asyncHanlder(async (req, res) => {
//   const { token, trial_end_date, userId } = req.body;

//   // Create a payment method using the provided token
//   const paymentMethod = await stripe?.paymentMethods.create({
//     type: "card",
//     card: { token: token },
//   });

//   // Create a Stripe customer and attach the payment method
//   const customer = await stripe?.customers.create({
//     payment_method: paymentMethod.id,
//   });

//   // Subscribe the customer to the plan
//   const subscription = await stripe?.subscriptions.create({
//     customer: customer.id,
//     items: [{ price: "price_1Pc5OgEM69ysvIJbkNWRzVay" }], // Reemplaza con tu ID de plan real
//     trial_end: trial_end_date,
//     expand: ["latest_invoice.payment_intent"],
//   });

//   const user = await User.findById(userId);
//   if (!user) {
//     return res.status(404).json({ message: "User not found" });
//   }

//   const updatedUser = await User.findByIdAndUpdate(
//     userId,
//     { customerId: subscription.id },
//     { new: true }
//   );
//   console.log("Updated User:", updatedUser);
//   if (subscription) {
//     const trialEndDate = new Date(subscription.current_period_end * 1000); 
//     const options = { year: "numeric", month: "long", day: "numeric" };
//     const formattedTrialEndDate = trialEndDate.toLocaleDateString(
//       "es-ES",
//       options
//     );
//     const request = mailjet.post("send", { version: "v3.1" }).request({
//       Messages: [
//         {
//           From: {
//             Email: "bluelighttech22@gmail.com", // Tu email
//             Name: "bluelighttech22", // Tu nombre o el de tu empresa
//           },
//           To: [
//             {
//               Email: user.email, // Email del usuario registrado
//               Name: `${user.firstName} ${user.lastName}`, // Nombre del usuario
//             },
//           ],
//           Subject: "Bienvenidoo! Que alegria tenert aqui",
//           TextPart: `hola`,
//           HTMLPart: `<h3>Ha estudair ${user.firstName} soy nova, te dejo saber que tu periodo de prueba a comenzado exitosamente, recuerda que puedes lograr todos tus suenos si te esfuerzas mucho, tu periodo de prueba terminara el ${formattedTrialEndDate}<h3>`,
//         },
//       ],
//     });
//     request
//       .then((result) => {
//         console.log("Email sent successfully:", result.body);
//       })
//       .catch((err) => {
//         console.error("Error sending email:", err.statusCode);
//       });
//       res.json({ message: "Subscription creaddted successfully", subscription });
//   } else {
//     res.status(404).json({ message: "Subscription not found" });
//   }

//   res.json({ message: "Subscription creaddted successfully", subscription });
// });

const payment = asyncHanlder(async (req, res) => {
  const { token, trial_end_date, userId } = req.body;

  // Validar los campos obligatorios
  if (!token || !trial_end_date || !userId) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  try {
    // Crear método de pago
    const paymentMethod = await stripe.paymentMethods.create({
      type: "card",
      card: { token: token },
    });

    // Crear cliente en Stripe y adjuntar el método de pago
    const customer = await stripe.customers.create({
      payment_method: paymentMethod.id,
    });

    // Crear la suscripción
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: "price_1Pc5OgEM69ysvIJbkNWRzVay" }], // Reemplaza con tu ID de plan real
      trial_end: trial_end_date,
      expand: ["latest_invoice.payment_intent"],
    });

    // Validar si el usuario existe en la base de datos
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Actualizar el usuario con el ID del cliente de Stripe
    await User.findByIdAndUpdate(userId, { customerId: subscription.id }, { new: true });

    // Formatear la fecha de finalización del periodo de prueba
    const trialEndDate = new Date(subscription.current_period_end * 1000);
    const formattedTrialEndDate = trialEndDate.toLocaleDateString("es-ES", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    // Enviar el email con Mailjet
    await mailjet.post("send", { version: "v3.1" }).request({
      Messages: [
        {
          From: {
            Email: "bluelighttech22@gmail.com",
            Name: "bluelighttech22",
          },
          To: [{ Email: user.email, Name: `${user.firstName} ${user.lastName}` }],
          Subject: "¡Bienvenido! Que alegría tenerte aquí",
          
          HTMLPart: `
        <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px; background-color: #f9f9f9;">
         <h2 style="color: #ff8313;">¡Bienvenido, ${user.firstName}!</h2>
          <img src="https://bluenova.s3.us-east-2.amazonaws.com/Cara-Sad-Login.png" alt="Nova te da la bienvenida" style="width: 100%; max-width: 400px; height: auto; margin-bottom: 20px;"/>
          <p style="font-size: 18px; color: #333;">
            Hola ${user.firstName}, soy <strong>Nova</strong>, tu asistente personal. ¡Qué alegría tenerte con nosotros!
          </p>
          <p style="font-size: 16px; color: #333;">
            Tu periodo de prueba ha comenzado y finalizará el <strong>${formattedTrialEndDate}</strong>. Durante este tiempo, puedes explorar todas las funcionalidades que hemos creado para ayudarte a alcanzar tus sueños.
          </p>
          <p style="font-size: 16px; color: #333;">
            No dudes en aprovechar este periodo para sacar el máximo provecho. ¡Sigue esforzándote y no te rindas!
          </p>
          <p style="font-size: 14px; color: #666;">
            Saludos,<br/>
            <strong>NOVA</strong><br/>
            El equipo de <strong>Blue Light Tech</strong>
          </p>
        </div>
      `,
        },
      ],
    });

    res.json({ message: "Subscription created successfully", subscription });
  } catch (error) {
    console.error("Error processing payment:", error);
    res.status(500).json({ message: "Error processing payment", error: error.message });
  }
});


const checkpayment = asyncHanlder(async (req, res) => {
  const { userId } = req.params;

  // Validar que se haya proporcionado un userId
  if (!userId) {
    return res.status(400).json({ message: "Missing userId" });
  }

  try {
    // Buscar al usuario por su ID
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Obtener la suscripción usando el customerId del usuario
    const subscription = await stripe.subscriptions.retrieve(user.customerId);
    if (!subscription) {
      return res.status(404).json({ message: "Subscription not found" });
    }

    // Responder con la información de la suscripción
    res.json({ message: "Subscription retrieved successfully", subscription });
  } catch (error) {
    console.error("Error retrieving subscription:", error); // Log para depuración
    res.status(500).json({
      message: "Error retrieving subscription",
      error: error.message,
    });
  }
});

const cancelSuscription = asyncHanlder(async (req, res) => {
  const { userId } = req.params; // userId se envía en el cuerpo de la solicitud
  console.log("userId", userId);

  // Buscar al usuario por userId
  const user = await User.findById(userId);
  console.log("user", user);

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  try {
    // Usar el ID de suscripción almacenado en `customerId` para cancelar la suscripción
    const deletedSubscription = await stripe.subscriptions.cancel(
      user.customerId
    );
    console.log("deletedSubscription", deletedSubscription);

    // Actualizar la base de datos, por ejemplo, eliminando el customerId o marcando la suscripción como cancelada

    const request = mailjet.post("send", { version: "v3.1" }).request({
      Messages: [
        {
          From: {
            Email: "bluelighttech22@gmail.com", // Tu email
            Name: "bluelighttech22", // Tu nombre o el de tu empresa
          },
          To: [
            {
              Email: user.email, // Email del usuario registrado
              Name: `${user.firstName} ${user.lastName}`, // Nombre del usuario
            },
          ],
          Subject: "Sentimos mucho que te vayas",
          TextPart: `hey ${user.firstName} ${user.lastName}, aqui estaremos mejorando por si deseas volver.`,
          HTMLPart: `
            <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px;">
              <h2 style="color: #ff8313;">Esperamos vuelvas pronto, ${user.firstName} ${user.lastName}.</h2>
              <img src="https://bluenova.s3.us-east-2.amazonaws.com/Cara-Sad-Logout.png" alt="Imagen de despedida" style="width: 100%; max-width: 600px; height: auto; border-radius: 10px;"/>
              <p style="font-size: 16px; color: #333;">
                Hola ${user.firstName} ${user.lastName}, lamentamos que hayas decidido irte. Queremos que sepas que 
                estamos trabajando duro para mejorar y ofrecerte una mejor experiencia.
              </p>
              <p style="font-size: 16px; color: #333;">
                Si decides regresar, siempre serás bienvenido en nuestra comunidad. ¡Te esperamos con los brazos abiertos!
              </p>
              <p style="font-size: 14px; color: #666;">
                Saludos cordiales,<br/>El equipo de <strong>bluelighttech22</strong>
              </p>
            </div>
          `,
        },
      ],
    });
    request
      .then((result) => {
        console.log("Email sent successfully:", result.body);
      })
      .catch((err) => {
        console.error("Error sending email:", err.statusCode);
      });

    res.json({
      message: "Subscription canceled successfully",
      subscription: deletedSubscription,
    });
  } catch (error) {
    console.error("Error canceling subscription:", error);
    res
      .status(500)
      .json({ message: "Error canceling subscription", error: error.message });
  }
});

module.exports = {
  payment,
  checkpayment,
  cancelSuscription,
};
