/*jshint esversion: 6 */
import seq     from 'seq';
import request from 'request';

import errorCodes   from '../config/errorCodes';
import dbConnection from '../db/dbConnection'; 
import utils        from '../utils/response';
import logger       from '../utils/logger';
import haToken      from '../integration/healthAwareToken';

let sendUpdox = {};
sendUpdox.SEND_PDF_FILE_TIMEOUT = 2 * 60000;     // n * 60 secs

sendUpdox.sendPdfToUpdox = (orgId, mrn, hraStatus, pdfFile, next) => {
    let options = {
        method: 'POST',
        url: hraUrl.url+'/send_to_updox',
        headers: {
            Accept: 'application/json',
            Authorization: result.token_type + ' ' + result.access_token
        },
        multipart:[{ 
                    'content-type'  :  'application/json',
                    'body'          : JSON.stringify({
                        "patient_id" : mrn,
                        "org_id"     : orgId,
                        "hra_status" : hraStatus,
                        "pdf_file"   : pdfFile
                             })
                    }]
    };
    request(options, (error, response, body) => {
        if (error || response.statusCode < 200 || response.statusCode >= 300)
        {
            logger.error(error);
            next(error, null);
        }
        result.body = body;
        next(null, body);
    });
};

sendUpdox.processNotifications = (connection) => {

    if (++sendUpdox.rescueIndex < sendUpdox.items.length)
    {
        let resultRow = sendUpdox.items[sendUpdox.rescueIndex];
        
        let orgId     = resultRow.org_id;
        let mrn       = resultRow.mrn;
        let hraStatus = resultRow.hra_status;
        let pdfFile   = resultRow.pdf_file;

        seq()
            .seq(function() {

                let self = this;
                result.errorCode = errorCodes.SUCCESS;
                haToken.getToken(result, self);
            })
            .seq(function(){
                sendUpdox.sendPdfToUpdox(orgId, mrn, hraStatus, pdfFile, (error, result)=>{
                    if(error)
                    {
                        logger.error('Error in Process notification to send to updox');
                        logger.error(error.sendUpdox);
                        sendUpdox.processNotifications(connection);
                    } 
                    else 
                    {
                        logger.debug('successfully sent to updox');
                        self();
                    }
                });
            })
            .seq(function()  {
                let self1 = this;
                let start_time = new Date();
                let deleteQuery = "DELETE FROM master.sendtoupdox WHERE id = " + connection.escapeLiteral(resultRow.id + '');
                logger.debug(deleteQuery);
                connection.query(deleteQuery, [], function (delerror, resultset) {
                    if (delerror)
                    {
                        logger.info(" took: " + (new Date() - start_time) + " for:" + deleteQuery);
                        logger.error(error);
                    }
                    self1();
                });
            })
            .seq(function ()  {
                sendUpdox.processNotifications(connection);
            });
    }
    else 
    {
        dbConnection.closeConnection(connection);
        setTimeout(sendUpdox.notifications, sendUpdox.SEND_PDF_FILE_TIMEOUT);
    }
};

sendUpdox.notifications = () => {

    dbConnection.createConnection((error, connection) => { //Get user by status from - except final status

        if (error) 
        {
            if (dbConnection)
                dbConnection.closeConnection(connection);

            logger.error(error);
            setTimeout(sendUpdox.notifications, sendUpdox.SEND_PDF_FILE_TIMEOUT);
        }
        else 
        {
            let self = this;
            let start_time = new Date();
            let querystring = "select * from master.sendtoupdox";
            logger.debug(querystring);
            connection.query(querystring, (err, resultset) => {
                if (err || resultset.rows.length === 0)
                {
                    if (err) logger.error(err);
                    dbConnection.closeConnection(connection);
                    setTimeout(sendUpdox.notifications, sendUpdox.SEND_PDF_FILE_TIMEOUT);
                }
                else 
                {
                    logger.info(" took: " + (new Date() - start_time) + " for:" + querystring);
                    sendUpdox.rescueIndex = -1;
                    sendUpdox.items = resultset.rows;
                    sendUpdox.processNotifications(connection);
                }
            });
        }
    });
};

setTimeout(sendUpdox.notifications, sendUpdox.MAX_EMAIL_NOTIFICATION_TIMEOUT);


export default sendUpdox;