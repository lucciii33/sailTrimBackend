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
  if (!token || !userId) {
    return res.status(400).json({ message: "Missing required fields" });
  }

  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.hasTrial) {
      // return res
      //   .status(400)
      //   .json({ message: "You have already used your free trial." });
      res.locals.message = "You have already used your free trial, proceeding to charge.";
    }
    // Crear método de pago
    const paymentMethod = await stripe.paymentMethods.create({
      type: "card",
      card: { token: token },
    });

    // Crear cliente en Stripe y adjuntar el método de pago
    const customer = await stripe.customers.create({
      payment_method: paymentMethod.id,
      name: `${user.firstName} ${user.lastName}`, // Pasar nombre del usuario desde la base de datos
      email: user.email,
      invoice_settings: {
        default_payment_method: paymentMethod.id, // Esto garantiza que este método de pago será utilizado para los cobros.
      },
    });

    // Crear la suscripción
    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: "price_1Pc5OgEM69ysvIJbkNWRzVay" }], // Reemplaza con tu ID de plan real
      trial_period_days: user.hasTrial ? 0 : 1,
      payment_behavior: "default_incomplete",
      expand: ["latest_invoice.payment_intent"],
    });

    console.log("subscriptionsubscriptionsubscription", subscription)
    const paymentIntent = subscription.latest_invoice
      ? subscription.latest_invoice.payment_intent
      : null;

      console.log("latest_invoicelatest_invoicelatest_invoicelatest_invoice", subscription.latest_invoice)
    // Si la suscripción está en período de prueba, no esperes `payment_intent`
    if (subscription.status === 'trialing') {
      const trialEndDate = new Date(subscription.current_period_end * 1000);
      const formattedTrialEndDate = trialEndDate.toLocaleDateString("es-ES", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      await mailjet.post("send", { version: "v3.1" }).request({
        Messages: [
          {
            From: {
              Email: "bluelighttech22@gmail.com",
              Name: "bluelighttech22",
            },
            To: [
              { 
              Email: user.email, 
              Name: `${user.firstName} ${user.lastName}` 
            },
            ],
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

      user.hasTrial = true; // El usuario ha usado su trial
      user.customerIdStripe = customer.id; // Guardar el ID del cliente de Stripe en `customerIdStripe`
      user.customerId = subscription.id; // Guardar el ID de la suscripción en `customerId`
      await user.save(); // Guardar cambios en la base de datos

      return res.json({
        message: "Subscription created successfully with trial period",
        subscription,
      });
    }

    // Si no hay `payment_intent`, devolver error
    if (!paymentIntent) {
      return res.status(400).json({ message: "Payment intent not found" });
    }

    // Manejar el caso de 3D Secure
    if (paymentIntent.status === "requires_action" && paymentIntent.next_action.type === "use_stripe_sdk") {
      return res.json({
        requiresAction: true,
        clientSecret: paymentIntent.client_secret,
      });
    }

    user.hasTrial = true; // Ahora el usuario ya usó su trial
    user.customerIdStripe = customer.id; // Guarda el ID del cliente de Stripe en `customerIdStripe`
    user.customerId = subscription.id; // Guarda el ID de la suscripción en `customerId`
    await user.save(); // Guardar cambios en la base de datos

    // Formatear la fecha de finalización del periodo de prueba
    // const trialEndDate = new Date(subscription.current_period_end * 1000);
    // const formattedTrialEndDate = trialEndDate.toLocaleDateString("es-ES", {
    //   year: "numeric",
    //   month: "long",
    //   day: "numeric",
    // });

    // Enviar el email con Mailjet
    // await mailjet.post("send", { version: "v3.1" }).request({
    //   Messages: [
    //     {
    //       From: {
    //         Email: "bluelighttech22@gmail.com",
    //         Name: "bluelighttech22",
    //       },
    //       To: [
    //         { 
    //         Email: user.email, 
    //         Name: `${user.firstName} ${user.lastName}` 
    //       },
    //       ],
    //       Subject: "¡Bienvenido! Que alegría tenerte aquí",

    //       HTMLPart: `
    //     <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px; background-color: #f9f9f9;">
    //      <h2 style="color: #ff8313;">¡Bienvenido, ${user.firstName}!</h2>
    //       <img src="https://bluenova.s3.us-east-2.amazonaws.com/Cara-Sad-Login.png" alt="Nova te da la bienvenida" style="width: 100%; max-width: 400px; height: auto; margin-bottom: 20px;"/>
    //       <p style="font-size: 18px; color: #333;">
    //         Hola ${user.firstName}, soy <strong>Nova</strong>, tu asistente personal. ¡Qué alegría tenerte con nosotros!
    //       </p>
    //       <p style="font-size: 16px; color: #333;">
    //         Tu periodo de prueba ha comenzado y finalizará el <strong>${formattedTrialEndDate}</strong>. Durante este tiempo, puedes explorar todas las funcionalidades que hemos creado para ayudarte a alcanzar tus sueños.
    //       </p>
    //       <p style="font-size: 16px; color: #333;">
    //         No dudes en aprovechar este periodo para sacar el máximo provecho. ¡Sigue esforzándote y no te rindas!
    //       </p>
    //       <p style="font-size: 14px; color: #666;">
    //         Saludos,<br/>
    //         <strong>NOVA</strong><br/>
    //         El equipo de <strong>Blue Light Tech</strong>
    //       </p>
    //     </div>
    //   `,
    //     },
    //   ],
    // });

    return res.json({
      message: res.locals.message || "Subscription created successfully",
      subscription,
    });
    
  } catch (error) {
    console.error("Error processing payment:", error);
    res
      .status(500)
      .json({ message: "Error processing payment", error: error.message });
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

const updatePaymentMethod = async (req, res) => {
  const { userId, paymentMethodId } = req.body;

  try {
    // Encuentra al usuario en tu base de datos
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Adjuntar el nuevo método de pago al cliente en Stripe
    await stripe.paymentMethods.attach(paymentMethodId, {
      customer: user.customerId,
    });

    // Establecer el nuevo método como predeterminado
    await stripe.customers.update(user.customerIdStripe, {
      invoice_settings: {
        default_payment_method: paymentMethodId,
      },
    });

    res.json({ message: "Payment method updated successfully" });
  } catch (error) {
    console.error("Error updating payment method:", error);
    res
      .status(500)
      .json({ message: "Error updating payment method", error: error.message });
  }
};

const cancelSuscription = asyncHanlder(async (req, res) => {
  const { userId } = req.params;

  // Buscar al usuario por userId
  const user = await User.findById(userId);
  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  try {
    // Primero, obtener la suscripción del usuario
    const subscription = await stripe.subscriptions.retrieve(user.customerId);

    // Verificar si obtuviste correctamente la información de la suscripción
    if (!subscription) {
      return res.status(404).json({ message: "Subscription not found" });
    }

    // Verificar si la suscripción está en período de prueba
    if (subscription.status === "trialing") {
      // CASO: Si la suscripción está en el período de prueba, usar `cancel` en lugar de `del`
      const deletedSubscription = await stripe.subscriptions.cancel(
        subscription.id
      ); // Cambié `del` a `cancel`

      // Actualizar la base de datos si es necesario, por ejemplo, eliminando el customerId
      await User.findByIdAndUpdate(userId, { customerId: null }, { new: true });

      // Enviar email de confirmación
      await mailjet.post("send", { version: "v3.1" }).request({
        Messages: [
          {
            From: {
              Email: "bluelighttech22@gmail.com",
              Name: "bluelighttech22",
            },
            To: [
              {
                Email: user.email,
                Name: `${user.firstName} ${user.lastName}`,
              },
            ],
            Subject: "Sentimos mucho que te vayas",
            TextPart: `Hola ${user.firstName} ${user.lastName}, aquí estaremos mejorando por si deseas volver.`,
            HTMLPart: `
              <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px;">
                <h2 style="color: #ff8313;">Esperamos vuelvas pronto, ${user.firstName} ${user.lastName}.</h2>
                <img src="https://bluenova.s3.us-east-2.amazonaws.com/Cara-Sad-Logout.png" alt="Imagen de despedida" style="width: 100%; max-width: 600px; height: auto; border-radius: 10px;"/>
                <p style="font-size: 16px; color: #333;">
                  Hola ${user.firstName}, lamentamos que hayas decidido irte. Estamos trabajando duro para mejorar.
                </p>
                <p style="font-size: 14px; color: #666;">
                  Saludos,<br/>El equipo de <strong>Blue Light Tech</strong>
                </p>
              </div>
            `,
          },
        ],
      });

      return res.json({
        message: "Subscription canceled successfully during trial period",
        subscription: deletedSubscription,
      });
    } else {
      // Si no está en período de prueba, cancelar al final del período de facturación
      const updatedSubscription = await stripe.subscriptions.update(
        subscription.id,
        { cancel_at_period_end: true }
      );

      // Enviar el email de confirmación
      await mailjet.post("send", { version: "v3.1" }).request({
        Messages: [
          {
            From: {
              Email: "bluelighttech22@gmail.com",
              Name: "bluelighttech22",
            },
            To: [
              {
                Email: user.email,
                Name: `${user.firstName} ${user.lastName}`,
              },
            ],
            Subject: "Sentimos mucho que te vayas",
            TextPart: `Hola ${user.firstName} ${user.lastName}, tu suscripción ha sido cancelada y terminará al final del periodo de facturación actual.`,
            HTMLPart: `
              <div style="font-family: Arial, sans-serif; text-align: center; padding: 20px;">
                <h2 style="color: #ff8313;">Esperamos vuelvas pronto, ${user.firstName} ${user.lastName}.</h2>
                <img src="https://bluenova.s3.us-east-2.amazonaws.com/Cara-Sad-Logout.png" alt="Imagen de despedida" style="width: 100%; max-width: 600px; height: auto; border-radius: 10px;"/>
                <p style="font-size: 16px; color: #333;">
                  Hola ${user.firstName}, tu suscripción ha sido cancelada exitosamente. Continuarás teniendo acceso hasta el final del periodo de facturación.
                </p>
                <p style="font-size: 14px; color: #666;">
                  Saludos,<br/>El equipo de <strong>Blue Light Tech</strong>
                </p>
              </div>
            `,
          },
        ],
      });

      return res.json({
        message:
          "Subscription will be canceled at the end of the billing period",
        subscription: updatedSubscription,
      });
    }
  } catch (error) {
    console.error("Error canceling subscription:", error);
    return res
      .status(500)
      .json({ message: "Error canceling subscription", error: error.message });
  }
});

module.exports = {
  payment,
  checkpayment,
  cancelSuscription,
  updatePaymentMethod,
};
