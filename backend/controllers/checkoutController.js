const asyncHanlder = require('express-async-handler')
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
console.log("stripe", stripe)
console.log("process.env.STRIPE_SECRET_KEY", process.env.STRIPE_SECRET_KEY)
const User = require("../model/userModel");

const payment = asyncHanlder(async(req, res) => {
    const { token, trial_end_date, userId  } = req.body;

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
    const subscription = await stripe?.subscriptions.create({
        customer: customer.id,
        items: [{ price: 'price_1Pc5OgEM69ysvIJbkNWRzVay' }], // Reemplaza con tu ID de plan real
        trial_end: trial_end_date,
        expand: ['latest_invoice.payment_intent'],
    });

    const user = await User.findById(userId);
    if (!user) {
        return res.status(404).json({ message: 'User not found' });
    }

    const updatedUser = await User.findByIdAndUpdate(userId, { customerId: subscription.id }, { new: true });
    console.log('Updated User:', updatedUser);

    res.json({ message: 'Subscription creaddted successfully', subscription });
})

const checkpayment = asyncHanlder(async(req, res) => {
  const { userId } = req.params; // Obtener ID de usuario de la ruta
    console.log("userId", userId)
    // Buscar al usuario por userId
    const user = await User.findById(userId);
    console.log("user", user)

    if (!user) {
        return res.status(404).json({ message: 'User not found' });
    }
    try {
        const subscription = await stripe?.subscriptions.retrieve(user.customerId);
        res.json({ subscription });
    } catch (error) {
        console.error('Error retrieving subscriptions:', error); // Log para depuración
        res.status(500).json({ message: 'Error retrieving subscriptions', error: error.message });
    }
})

const cancelSuscription = asyncHanlder(async(req, res) => {
    const { userId } = req.params; // userId se envía en el cuerpo de la solicitud
    console.log("userId", userId);

    // Buscar al usuario por userId
    const user = await User.findById(userId);
    console.log("user", user);

    if (!user) {
        return res.status(404).json({ message: 'User not found' });
    }

    try {
        // Usar el ID de suscripción almacenado en `customerId` para cancelar la suscripción
        const deletedSubscription = await stripe.subscriptions.cancel(user.customerId);
        console.log("deletedSubscription", deletedSubscription);

        // Actualizar la base de datos, por ejemplo, eliminando el customerId o marcando la suscripción como cancelada
 

        res.json({ message: 'Subscription canceled successfully', subscription: deletedSubscription });
    } catch (error) {
        console.error('Error canceling subscription:', error);
        res.status(500).json({ message: 'Error canceling subscription', error: error.message });
    }
  })

module.exports = {
    payment,
    checkpayment,
    cancelSuscription
}