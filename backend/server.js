const express = require('express')
const colors = require('colors')
const dotenv = require('dotenv').config()
const port = process.env.PORT || 5000
const {errorHandler} = require('./middleware/errorMiddleware')
const connectDB = require('./config/db')
const resetLoginDaysJob = require('./jobs/jobsLoginDays'); // Ruta al cron job
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);


connectDB()

const app = express()

app.use(express.json())
app.use(express.urlencoded({extended: false}))
app.use(cors());
console.log('JWT_SECRET:', process.env.JWT_SECRET_NODE);


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