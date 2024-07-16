const asyncHanlder = require('express-async-handler')
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const payment = asyncHanlder(async(req, res) => {
    const { token, trial_end_date } = req.body;

    // Create a payment method using the provided token
    const paymentMethod = await stripe?.paymentMethods.create({
        type: 'card',
        card: { token: token },
    });

    // Create a Stripe customer and attach the payment method
    const customer = await stripe?.customers.create({
        payment_method: paymentMethod.id,
    });

    // Subscribe the customer to the plan
    const subscription = await stripe.subscriptions.create({
        customer: customer.id,
        items: [{ price: 'price_1Pc5OgEM69ysvIJbkNWRzVay' }], // Reemplaza con tu ID de plan real
        trial_end: trial_end_date,
        expand: ['latest_invoice.payment_intent'],
    });

    res.json({ message: 'Subscription created successfully', subscription });
})

const checkpayment = asyncHanlder(async(req, res) => {
    const { customerId } = req.params; // Obtener ID de cliente de la ruta

  // Recuperar la suscripción del cliente
  const subscription = await stripe?.subscriptions.retrieve(customerId);

  // Enviar estado de la suscripción al cliente
  res.json({ subscription });
})

module.exports = {
    payment,
    checkpayment
}