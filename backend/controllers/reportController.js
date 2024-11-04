const asyncHanlder = require("express-async-handler");
const User = require("../model/userModel");
const Mailjet = require("node-mailjet");

const mailjet = Mailjet.apiConnect(
  process.env.MJ_APIKEY_PUBLIC,
  process.env.MJ_APIKEY_PRIVATE
);

const reportAndIssue = asyncHanlder(async (req, res) => {
  const { report, userId } = req.body;
  const user = await User.findById(userId);

  if (!user) {
    res.status(400);
    throw new Error("El usuario no existe");
  }

  // Correo a "Nova"
  const sendToNova = mailjet.post("send", { version: "v3.1" }).request({
    Messages: [
      {
        From: {
          Email: "bluelighttech22@gmail.com",
          Name: `bluelighttech22@gmail.com`,
        },
        To: [
          {
            Email: "novaappai@gmail.com",
            Name: "Blue Light Tech",
          },
        ],
        Subject: "REPORT!!!!!!",
        TextPart: "REPORT",
        HTMLPart: `
            <div style="font-family: Arial, sans-serif; color: #333333; line-height: 1.6; background-color: #F7F7F7; padding: 20px; text-align: center;">
                <p>${report}</p>
            </div>
          `,
      },
    ],
  });

  // Correo de confirmación al usuario
  const sendToUser = mailjet.post("send", { version: "v3.1" }).request({
    Messages: [
      {
        From: {
          Email: "bluelighttech22@gmail.com",
          Name: "Blue Light Tech",
        },
        To: [
          {
            Email: user.email,
            Name: `${user.firstName} ${user.lastName}`,
          },
        ],
        Subject: "Hemos recibido tu reporte",
        TextPart: "REPORT",
        HTMLPart: `
            <div style="font-family: Arial, sans-serif; color: #333333; line-height: 1.6; background-color: #F7F7F7; padding: 20px; text-align: center;">
                <p>Hemos recibido tu reporte</p>
            </div>
          `,
      },
    ],
  });

  // Enviar ambos correos en paralelo y manejar errores
  try {
    const [resultNova, resultUser] = await Promise.all([
      sendToNova,
      sendToUser,
    ]);
    console.log("Email sent successfully to Nova:", resultNova.body);
    console.log(
      "Confirmation email sent successfully to User:",
      resultUser.body
    );
    return res.status(200).json({ message: "Reporte enviado exitosamente" });
  } catch (error) {
    console.error("Error sending emails:", error.statusCode);
    return res
      .status(500)
      .json({ error: "Hubo un problema al enviar los correos" });
  }
});

module.exports = {
  reportAndIssue,
};
