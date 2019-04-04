/*jshint esversion: 6 */
import fs           from 'fs';
import nodemailer   from 'nodemailer';
import moment       from 'moment';
import sgMail       from '@sendgrid/mail';
import seq          from 'seq';
import request      from 'request';

// Requiring user dependencies
import {app,sendgrid,mode,textsms,userMails} from '../config/config';
import errorCodes   from '../config/errorCodes';
import dbConnection from '../db/dbConnection'; 
import utils        from '../utils/response';
import logger       from '../utils/logger';

let email_auth      = JSON.parse(fs.readFileSync(app.email_notifier_auth_file, 'utf8'));

let transporter = nodemailer.createTransport({
    service: "Gmail",
    auth: email_auth
});

let message = {};

message.MAX_EMAIL_NOTIFICATION_TIMEOUT = 2 * 60000;     // n * 60 secs
message.rescueIndex = -1;
message.items = [];
 
//for send email
message.sendmail = (resultRow, cb) => {
    if (userMails.provider == "sendgrid") 
    {
        sgMail.setApiKey(sendgrid[mode.server_mode + "_key"]);
        const msg =
            {
                to: resultRow.email_to.trim(),
                from: resultRow.email_from.trim(),
                subject: resultRow.subject.trim(),
                html: resultRow.html_message.trim(),
            };
        sgMail.send(msg).then(() => {
            logger.debug("mail sent successfully");
            cb(null);
        }).catch(error => {
            logger.debug(JSON.stringify(error.response.body.errors));
            cb(error);
        });
    } 
    else 
    {
        let mailOptions = {
            from: resultRow.email_from,     // sender address
            to: resultRow.email_to,         // list of receivers
            subject: resultRow.subject,
            generateTextFromHTML: true,
            html: resultRow.html_message
        };

        // send mail with defined transport object
        transporter.sendMail(mailOptions, (error, info) => {
            cb(error);
        });
    }
};

message.sendText = (resultRow, cb) => {
    
    let linkStr = textsms.protocol + textsms.host + '/sendsms?username=' + textsms.username + '&password=' + textsms.password + '&from=' + textsms.from + '&to=1' + resultRow.to + '&text="' + resultRow.html_message + '"';
    logger.debug("Text message URL: " + linkStr);
    // http://162.212.245.20:4848/sendsms?username=Guth_Tech&password=6uthT3ch&from=4842658234&to=16787788500&text=�This is a test�

    let headers = { "content-type": "multipart/form-data" };

    let options =
        {
            url: linkStr,
            method: "GET",
            followRedirect: true,
            followAllRedirects: true,
            rejectUnauthorized: false,
            headers: headers
        };
    logger.info('SMS - ', linkStr);
    request(options, (error, res, body) => {
        cb(error);
    });
};

message.processNotifications = (connection) => {

    if (++message.rescueIndex < message.items.length) 
    {
        let resultRow = message.items[message.rescueIndex];
        let email_to = resultRow.email;
        let opt_in_id = resultRow.opt_in_id;

        seq()
            .seq(function() {

                let self = this;
                switch (resultRow.type) {
                    case 'email':
                        message.sendmail(resultRow, (error) => {
                            if (error) 
                            {
                                
                                logger.error('Error in Process notification mail');
                                logger.error(error.message);
                                message.processNotifications(connection);
                            } 
                            else 
                            {
                                
                                logger.debug('email message correct');
                                self();
                            }
                        });
                        break;
                    case 'text':
                        message.sendText(resultRow, (error) => {
                            if (error) 
                            {
                                logger.error('Error in sending Text notification');
                                logger.error(error.message);
                                message.processNotifications(connection);
                            } 
                            else 
                            {
                                logger.debug('text message correct');
                                self();
                            }
                        });
                        break;
                }
            })
            .seq(function()  {
                let self1 = this;
                let start_time = new Date();
                let deleteQuery = "DELETE FROM master.messagenotification WHERE id = " + connection.escapeLiteral(resultRow.id + '');
                logger.debug(deleteQuery);
                connection.query(deleteQuery, [], function (delerror, resultset) {
                    if (delerror) 
                    {
                        logger.info(" took: " + (new Date() - start_time) + " for:" + deleteQuery);
                        dbConnection.closeConnection(connection);
                        logger.error(error);
                    }
                    self1();
                });
            })
            .seq(function()  {
                message.processNotifications(connection);
            });
    }
    else 
    {
        dbConnection.closeConnection(connection);
        setTimeout(message.notifications, message.MAX_EMAIL_NOTIFICATION_TIMEOUT);
    }
};

message.notifications = () => {

    dbConnection.createConnection((error, connection) => { //Get user by status from - except final status

        if (error) 
        {
            if (dbConnection)
                dbConnection.closeConnection(connection);

            logger.error(error);
            setTimeout(message.notifications, message.MAX_EMAIL_NOTIFICATION_TIMEOUT);
        }
        else 
        {
            let self = this;
            let start_time = new Date();
            let querystring = "select * from master.messagenotification";
            logger.debug(querystring);
            connection.query(querystring, (err, resultset) => {
                if (err || resultset.rows.length === 0) 
                {
                    if (err) logger.error(err);
                    dbConnection.closeConnection(connection);
                    setTimeout(message.notifications, message.MAX_EMAIL_NOTIFICATION_TIMEOUT);
                }
                else 
                {
                    logger.info(" took: " + (new Date() - start_time) + " for:" + querystring);
                    message.rescueIndex = -1;
                    message.items = resultset.rows;
                    message.processNotifications(connection);
                }
            });
        }
    });
};

if (userMails != undefined) 
{
    setTimeout(message.notifications, message.MAX_EMAIL_NOTIFICATION_TIMEOUT);
}

export default message;
