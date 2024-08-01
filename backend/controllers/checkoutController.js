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

    // if (!user.customerId) {
    //     return res.status(200).json({ message: 'User does not have a customerId' });
    // }

    // Recuperar todas las suscripciones del cliente usando el customerId
    try {
        const subscription = await stripe?.subscriptions.retrieve(user.customerId);
        res.json({ subscription });
    } catch (error) {
        console.error('Error retrieving subscriptions:', error); // Log para depuración
        res.status(500).json({ message: 'Error retrieving subscriptions', error: error.message });
    }
})

module.exports = {
    payment,
    checkpayment
}