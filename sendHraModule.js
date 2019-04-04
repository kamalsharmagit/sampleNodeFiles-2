/*jshint esversion: 6 */
import seq      from 'seq';
import download from 'download-file';
import fs       from 'fs';
import uuid     from 'uuid/v4';
import mkdirp   from 'mkdirp';

import utils        from '../utils/response';
import logger       from '../utils/logger';
import healthAware  from '../integration/healthAware';
import dbConnection from '../db/dbConnection';
import errorCodes   from '../config/errorCodes';
import message      from './message';                           //import to send notification mail/message
import sansoroSettingPage       from './sansoroSettingPage';
import {app, textsms, pdfUrl, hraUrl}   from '../config/config';
import {addZeroToMillisecond, isValid, isWithin24hr, isValidObj, isValidArray, isEmpty} from '../utils/validation';
import redox from '../integration/redox';


let sendHra = {};

//Get org IDs and correspondening assessments from "sansoro_setting" table
sendHra.getOrgIds = (request, response) => {
        
    let result = {};
    result.errorCode = errorCodes.SUCCESS;
    
    sansoroSettingPage.getLocIDFromDB(result, (error, resultSet) => {

        if (error || ! isValid(resultSet))
        {
            logger.error(error.message);
            utils.respondBack(request, response, error, null);
        } 
        else
        {
            let results = {};
            results.errorCode = errorCodes.SUCCESS;
            results.data = (resultSet.data);
            utils.respondBack(request, response, results, null);
        }
    });
};

//process of send HRA to pateints
sendHra.sendHraProcess = (emailId, mobile, patientName, mrnNo, type, assessmentId, orgId, callback) => {

    let result = {};

    let firstName = null;
    let middleName = null;
    let lastName = null;

    result.errorCode = errorCodes.SUCCESS;
    let nameArray = patientName.split(" ");
    if(nameArray.length > 2)
    {
         firstName = nameArray[0];
         middleName = nameArray[1];
         lastName = nameArray[2];
        
    }else if(nameArray.length > 1)
    {
         firstName = nameArray[0];
         middleName = null;
         lastName = nameArray[1];
        
    }else if(nameArray.length == 1)
    {
         firstName = nameArray[0];
         middleName = null;
         lastName = null;
    }else{
        firstName = null;
         middleName = null;
         lastName = null;
    }
    
    seq()
        .seq(function() {
            var self = this;
            dbConnection.createConnection((error, connection) => {
                if (error) 
                {
                    result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                    logger.error(error.message);
                    callback(error, null);
                }
                else   
                {   
                    let start_time = new Date();
                    let queryString = "select * from master.patient_info where mrn ='"+mrnNo+"' ";
                    connection.query(queryString, (error, resultSet) => {
                        if (error) 
                        {
                            logger.info(" took: " + (new Date() - start_time) + " for:" + queryString);
                            result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                            logger.error(error.message);
                            dbConnection.closeConnection(connection);
                            callback(error, null);
                        }
                        else if(resultSet.rows.length == 0)
                        {
                            sendHra.addPatientInfo(mrnNo, firstName, middleName, lastName, emailId, mobile, (error, success) => {
                                if(error) {
                                    result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                                    result.errorMsg = error.message;
                                    logger.error(result.errorMsg);
                                    dbConnection.closeConnection(connection);
                                    callback(error, null);
                                }
                                else 
                                {
                                    //dbConnection.closeConnection(connection);
                                    // self();
                                    callback(null, result);
                                }
                            });
                        }
                        else
                        {
                            sendHra.updatePatientInfo(mrnNo, firstName, middleName, lastName, emailId, mobile, (error, success) => {
                                if(error)
                                {
                                    result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                                    result.errorMsg = error.message;
                                    logger.error(result.errorMsg);
                                    dbConnection.closeConnection(connection);
                                    callback(error, null);
                                }
                                else   
                                {   
                                    let start_time = new Date();
                                    let updateQuery = "UPDATE master.hra_status SET patient_name = $1, email = $2, phone = $3 WHERE mrn ='"+mrnNo+"'";
                                    logger.debug(updateQuery);
                                    connection.query(updateQuery, [patientName, emailId, mobile], (error, success) => {
                                        if (error) 
                                        {
                                            logger.info(" took: " + (new Date() - start_time) + "ms, for:" + updateQuery);
                                            result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                                            logger.error(error.message);
                                            dbConnection.closeConnection(connection);
                                            callback(error, null);
                                        }
                                        else 
                                        {
                                            logger.info(" took: " + (new Date() - start_time) + "ms, for:" + updateQuery);
                                            result.errorCode = errorCodes.SUCCESS;
                                            logger.debug("successfully updated HRA status");
                                            dbConnection.closeConnection(connection);
                                            callback(null, result);
                                        }
                                    });
                                }
                            });
                        }
                    });
                }
            });
        });
};


//send HRA content to patients
sendHra.sendHraToPatients = (request, response) => {
    
    let result = {};

    let emailId           = request.body.emailID,
        phone             = request.body.cellNumber,
        mrnNo             = request.body.patientMRN,
        patientName       = request.body.patientName,
        preferredChannel  = request.body.preferredChannel,
        physician         = request.body.physician,
        assessmentId      = request.body.AssessmentType.assessmentID,
        assessment        = request.body.AssessmentType,
        orgId             = request.body.org_id,
        dateSubmitted     = new Date();
    
    if( ! (isValid(emailId) && isValid(phone) && isValid(mrnNo) && isValid(assessmentId) && isValid(orgId)) )
    {
        result.errorCode = errorCodes.UNAUTHORIZED;
        logger.error("emailid, phone, mrn_no, assessment type or orgId is undefined");
        utils.respondBack(request, response, result, null);
        return;
    }

    emailId     = emailId.toString().trim();
    phone       = phone.toString().trim();
    mrnNo       = mrnNo.toString().trim();
    patientName = patientName.toString().trim().replace(/ +/g, ' ' );
    
    seq()
    .seq(function(){
        var self = this;
        sendHra.sendHraProcess(emailId, phone, patientName, mrnNo, preferredChannel, assessmentId, orgId, (error, hraLink) => {
            if(error)
            {  
                result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                logger.error(result.errorCode.message);
                utils.respondBack(request, response, result, null);
            }
            else
            {      
               self();
            }
        });

    }).seq(function(){
        var self = this;
        sendHra.addHRAStatus(mrnNo, preferredChannel, emailId, phone, assessmentId, dateSubmitted, physician, patientName, assessment, orgId, (error, resultSet) => {
                    
            if(error)
            {
                result = error;
                logger.error(result.errorMsg);
                utils.respondBack(request, response, result, null);
            } 
            else 
            {
                let hraLink = `https://api.healthawareservices.com/patient/${mrnNo}/assessment/${assessmentId}/link`;

                sendHra.setMessageNotification(hraLink, preferredChannel, emailId, phone, (error) => {

                    if (error) 
                    {
                        result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                        result.errorMsg = error.message;
                        logger.error(result.errorMsg);
                        utils.respondBack(request, response, result, null);
                    } 
                    else 
                    {
                        var results = {};
                        results.errorCode = errorCodes.SUCCESS;
                        results.data = resultSet;
                        results.within24hrs = false;
                        utils.respondBack(request, response, results, null);
                    }
                });
            }
        });
        
    });
    // .seq(function(){
    //     var self =this;
    //     let hraLink = `https://api.healthawareservices.com/patient/${mrnNo}/assessment/${assessmentId}/link`;

    //     sendHra.setMessageNotification(hraLink, preferredChannel, emailId, phone, (error) => {

    //         if (error) 
    //         {
    //             result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
    //             result.errorMsg = error.message;
    //             logger.error(result.errorMsg);
    //             utils.respondBack(request, response, result, null);
    //         } 
    //         else 
    //         {
    //             var results = {};
    //             results.errorCode = errorCodes.SUCCESS;
    //             results.data = resultSet;
    //             results.within24hrs = false;
    //             utils.respondBack(request, response, results, null);
    //         }
    //     });
    // });
    // sendHra.sendHraProcess(emailId, phone, patientName, mrnNo, preferredChannel, assessmentId, orgId, (error, hraLink) => {
    //     if(error)
    //     {  
    //         result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
    //         logger.error(result.errorCode.message);
    //         utils.respondBack(request, response, result, null);
    //     }
    //     else
    //     {      
    //         sendHra.addHRAStatus(mrnNo, preferredChannel, emailId, phone, assessmentId, dateSubmitted, physician, patientName, assessment, orgId, (error, resultSet) => {
                
    //             if(error)
    //             {
    //                 result = error;
    //                 logger.error(result.errorMsg);
    //                 utils.respondBack(request, response, result, null);
    //             } 
    //             else 
    //             {
    //                 let hraLink = `https://api.healthawareservices.com/patient/${mrnNo}/assessment/${assessmentId}/link`;
                    
    //                 sendHra.setMessageNotification(hraLink, preferredChannel, emailId, phone, (error) => {
    
    //                     if (error) 
    //                     {
    //                         result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
    //                         result.errorMsg = error.message;
    //                         logger.error(result.errorMsg);
    //                         utils.respondBack(request, response, result, null);
    //                     } 
    //                     else 
    //                     {
    //                         var results = {};
    //                         results.errorCode = errorCodes.SUCCESS;
    //                         results.data = resultSet;
    //                         results.within24hrs = false;
    //                         utils.respondBack(request, response, results, null);
    //                     }
    //                 });
                    
    //             }
    //         });

            
    //     }
    // });
};

//resend HRA content to patients
sendHra.resendHraToPatients = (request, response) => {
    
    let result = {};

    let mrnNo            = request.body.patientMRN.toString().trim();    //mrnNo = mrnNo.toString().trim();    
    let assessmentId     = request.body.assessmentId;
    let preferredChannel = request.body.preferredChannel;  
    let emailId          = request.body.emailID;
    let phone            = request.body.cellNumber;
    let orgId            = request.body.org_id;
    let dateSubmitted    = new Date();
    
    if( ! ( (isValid(emailId) || isValid(phone)) && isValid(mrnNo) && isValid(assessmentId) && isValid(orgId)) )
    {
        result.errorCode = errorCodes.UNAUTHORIZED;
        logger.error("patientMRN, orgId or assessmentId is null or undefined");
        utils.respondBack(request, response, result, null);
        return;
    }
    
    sendHra.resendHraProcess(mrnNo, assessmentId,dateSubmitted, orgId, (error, resultSet) => {
        if(error)
         {  
            result.errorCode = errorCodes.UNAUTHORIZED;
            logger.error(result.errorCode.message);
            utils.respondBack(request, response, result, null);
        }
        else
        {      

            let hraLink = `https://api.healthawareservices.com/patient/${mrnNo}/assessment/${assessmentId}/link`;
            sendHra.setMessageNotification(hraLink, preferredChannel, emailId, phone, (error) => {

                if (error) 
                {
                    result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                    result.errorMsg = error.message;
                    logger.error(result.errorMsg);
                    utils.respondBack(request, response, result, null);
                    
                } 
                else 
                {
                    var results = {};
                    results.errorCode = errorCodes.SUCCESS;
                    utils.respondBack(request, response, results, null);
                    
                }

            });
        }
    });
};

// prepare message for send email or text
sendHra.setMessageNotification = (linkstr, preferredChannel, email, userMobile, cb) => {

    if (typeof preferredChannel != 'undefined' && preferredChannel == "1" && typeof email != 'undefined') 
    {
        sendHra.getEmailMessageBody(email, linkstr).then((messageObj) => {
            sendHra.addMessageNotification(messageObj, cb);
        }, (err) => {
            cb(err);
        }); 
    }
    else if (typeof preferredChannel != 'undefined' && preferredChannel == "2" && typeof userMobile != 'undefined') 
    {
        sendHra.getTextMessageBody(userMobile, linkstr).then((messageObj) => {
            sendHra.addMessageNotification(messageObj, cb);
        }, (err) => {
            cb(err);
        });
    }
};

//prepare email template
sendHra.getEmailMessageBody = (emailid, linkstr) => {
    let mailSubject = "";
    let emailTemplatePath = app.emailTemplatePath;
    let messageObj = [];
    return new Promise((resolve, reject) => {

        fs.readFile(emailTemplatePath, (err, emailTemplate) => {
            if (err) 
            {
                logger.error(err);
                reject(err);
            } 
            else 
            {
                var emailTemplateStr = emailTemplate.toString();

                messageObj[messageObj.length] = emailid;                          					        // email_to
                messageObj[messageObj.length] = '"PatientPoint Support" < education@patientpoint.com>';     // email_from
                messageObj[messageObj.length] = 'Test for confirmation email'; 					            // Subject

                emailTemplateStr = emailTemplateStr.replace("__TITLE__", 'E-Mail Verification');
                emailTemplateStr = emailTemplateStr.replace("__BODY__", 'Click the Button here to open you Health Risk Assessment survey');
                emailTemplateStr = emailTemplateStr.replace("__URLLINK__", linkstr);
                emailTemplateStr = emailTemplateStr.replace("__BUTTONTEXT__", 'HRA Link');
                
                messageObj[messageObj.length] = "";                                 		                // cc
                messageObj[messageObj.length] = emailTemplateStr;									        // html_message
                messageObj[messageObj.length] = "pending";                          		                // status
                messageObj[messageObj.length] = 'email';                               	                    // type
            }
            resolve(messageObj);
        });
    });
};

//prepare text template
sendHra.getTextMessageBody = (userMobile, linkstr) => {

    var textSubject = "";
    var emailTemplatePath = app.textTemplatePath;
    var messageObj = [];

    return new Promise((resolve, reject) => {
        fs.readFile(emailTemplatePath, (err, emailTemplate) => {
            if (err) 
            {
                logger.error(err);
                reject(err);
            } 
            else 
            {
                var emailTemplateStr = emailTemplate.toString();

                messageObj[messageObj.length] = userMobile;   		                                    // to
                messageObj[messageObj.length] = textsms.from;  					                // from
                messageObj[messageObj.length] = 'Test for confirmation email'; 					        // Subject

                emailTemplateStr = emailTemplateStr.replace("__BODY__", 'Click the Button here to open you Health Risk Assessment survey');
                emailTemplateStr = emailTemplateStr.replace("__URLLINK__", linkstr);
                
                
                messageObj[messageObj.length] = "";                                                     // cc
                messageObj[messageObj.length] = emailTemplateStr.toString();		                    // html_message
                messageObj[messageObj.length] = "pending";                                              // status
                messageObj[messageObj.length] = 'text';					                                //type
            }
            resolve(messageObj);
        });
    });
};

// //insert organization info in DB
// sendHra.addOrgInfo = (orgId, phone, cb) => {
//     let address = null;
//     let city = null;
//     let state = null;
//     let country = null;
//     let zipCode = null;
//     let website = null;

//     let result = {};
//     result.errorCode = errorCodes.SUCCESS;
//     dbConnection.createConnection((error, connection) => {
//         if (error) 
//         {
//             result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
//             logger.error(error.message);
//             cb(error);
//         }
//         else 
//         {
                    
//             let start_time = new Date();
//             let insertQuery = "insert into master.org_info (org_id, org_name, address, city, state, country, zip_code, phone, website) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)";
//             logger.debug(insertQuery);
//             connection.query(insertQuery, [orgId, address, city, state, country, zipCode, phone, website], (errInsert, resultSet) => {
//                 if (errInsert) 
//                 {
//                     logger.info(" took: " + (new Date() - start_time) + "ms, for:" + insertQuery);
//                     result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
//                     logger.error(errInsert.message);
//                     dbConnection.closeConnection(connection);
//                     cb(result, null);
//                 }
//                 else 
//                 {
//                     logger.info(" took: " + (new Date() - start_time) + "ms, for:" + insertQuery);
//                     result.errorCode = errorCodes.SUCCESS;
//                     logger.debug("successfully inserted notification message info");
//                     dbConnection.closeConnection(connection);
//                     cb(null, result);
//                 }
//             });
//         }
//     });
// };

// update org info 
// sendHra.updateOrgInfo = (orgId, phone, cb) => {
    
//     let address = null;
//     let city = null;
//     let state = null;
//     let country = null;
//     let zipCode = null;
//     let website = null;

//     let result = {};
//     result.errorCode = errorCodes.SUCCESS;
//     dbConnection.createConnection((error, connection) => {
//         if (error) 
//         {
//             result.errorCode = errorCodes.INTERNAL_SERVER_ERROR
//             logger.error(error.message);
//             cb(error);
//         }
//         else 
//         {
//             let start_time = new Date();
//             let updateQuery = "UPDATE master.org_info SET org_name = $1,address = $2,city = $3,state = $4,country = $5,zip_code = $6,phone = $7, website = $8 WHERE org_id ="+orgId;
//             logger.debug(updateQuery);
//             connection.query(updateQuery, [address, city, state, country, zipCode, phone, website], (errInsert, resultSet) => {
//                 if (errInsert) 
//                 {
//                     logger.info(" took: " + (new Date() - start_time) + "ms, for:" + updateQuery);
//                     result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
//                     logger.error(errInsert.message);
//                     dbConnection.closeConnection(connection);
//                     cb(result, null);
//                 }
//                 else 
//                 {
//                     logger.info(" took: " + (new Date() - start_time) + "ms, for:" + updateQuery);
//                     result.errorCode = errorCodes.SUCCESS;
//                     logger.debug("successfully updated organization info");
//                     dbConnection.closeConnection(connection);
//                     cb(null, result);
//                 }
//             });
//         }
//     });
// };

//PART Of SENDHRA METHOD =|
// .seq(function() {
//     var self = this;
//     dbConnection.createConnection((error, connection) => {

//         if (error) 
//         {
//             result.errorCode = errorCodes.INTERNAL_SERVER_ERROR
//             logger.error(error.message);
//             callback(error, null);
//         }
//         else  
//         {

//             let start_time = new Date();
//             let queryString = "select * from master.org_info where org_id = "+orgId;
//             connection.query(queryString, (error, resultSet) => {
//                 if (error) 
//                 {
//                     logger.info(" took: " + (new Date() - start_time) + " for:" + queryString);
//                     result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
//                     logger.error(errInsert.message);
//                     dbConnection.closeConnection(connection);
//                     callback(error, null);
//                 }
//                 else if(resultSet.rows.length == 0)
//                 {
//                     sendHra.addOrgInfo(orgId, mobile, (error, success) => {
//                         if(error) 
//                         {
//                             result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
//                             result.errorMsg = error.message;
//                             logger.error(result.errorMsg);
//                             dbConnection.closeConnection(connection);
//                             callback(error, null);
//                         }
//                         else 
//                         {
//                             dbConnection.closeConnection(connection);
//                             self();
//                         }
//                     });
//                 }
//                 else 
//                 {
//                     sendHra.updateOrgInfo(orgId, mobile, (error, success) => {
//                         if(error)
//                         {
//                             result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
//                             result.errorMsg = error.message;
//                             logger.error(result.errorMsg);
//                             dbConnection.closeConnection(connection);
//                             callback(error, null);
//                         }
//                         else
//                         {
//                             dbConnection.closeConnection(connection);
//                             self();
//                         }
//                     });
//                 }
//             });
//         }
//     });
// })

//maintain hra status in db 
sendHra.addHRAStatus = (mrnNo, type, emailId, phone, assessmentId, dateSubmitted, physician, patientName, assessment, orgId,  cb) => {
    
    let result = {};
    // let start_time = new Date();
    let dateCompleted = null;
    
    dbConnection.createConnection((error, connection) => {
        if (error) 
        {
            result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
            logger.error(error.message);
            cb(result,null);
        }
        else 
        {
            let start_time = new Date();
            let selectQuery = "select date_completed from master.hra_status where mrn = $1 and assessment_id = $2 and org_id = $3 ";
            logger.debug(selectQuery);
            connection.query(selectQuery, [mrnNo, assessmentId, orgId], (error, resultSet) => {
                if (error) 
                {
                    logger.info(" took: " + (new Date() - start_time) + "ms, for:" + selectQuery);
                    result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                    logger.error(error.message);
                    dbConnection.closeConnection(connection);
                    cb(result, null);
                }
                else 
                {                    
                    let valid = true;
                    for (let date of resultSet.rows)
                    {
                        if (date.date_completed == null || ! isWithin24hr(start_time, date.date_completed))
                        {
                            valid = false;
                            break;
                        }
                    }
                   
                    if (valid)
                    {                    
                        let start_time = new Date();       
                        let hraStatus = 'pending';
                        let insertQuery = `insert into master.hra_status (org_id, mrn, hra_status, assessment_id, type, email, phone, date_submitted, date_completed, physician, patient_name, assessment) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) 
                                            RETURNING hra_status, assessment_id, id`;
                        logger.debug(insertQuery);
                        connection.query(insertQuery, [orgId, mrnNo, hraStatus, assessmentId, type, emailId, phone, dateSubmitted, dateCompleted, physician, patientName, assessment], (errInsert, resultSet) => {
                            if (errInsert) 
                            {
                                logger.info(" took: " + (new Date() - start_time) + "ms, for:" + insertQuery);
                                result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                                logger.error(errInsert.message);
                                dbConnection.closeConnection(connection);
                                cb(result, null);
                            }
                            else 
                            {
                                result.hraStatus = resultSet.rows[0].hra_status;
                                result.assessmentId = resultSet.rows[0].assessment_id;
                                result.id = resultSet.rows[0].id;
                                logger.info(" took: " + (new Date() - start_time) + "ms, for:" + insertQuery);
                                logger.debug("successfully inserted HRA status");
                                dbConnection.closeConnection(connection);
                                cb(null, result);
                            }
                        }); 
                    }
                    else
                    {
                        result.errorCode = errorCodes.SUCCESS;
                        result.within24hrs = true;
                        logger.error(result.errorCode.message);
                        dbConnection.closeConnection(connection);
                        cb(result, null);
                    }
                }
            });
        }
    });
};


//insert patient info into DB
sendHra.addPatientInfo = (mrn, firstName, middleName, lastName, emailAddres, phoneNumbers, cb) => {
    
    let salutation = null;
    let suffix = null;
    let gender  = null;
    let birthDate = null;
    let maritalStatus = null;
    let bloodType = null;
    let addressLine1 = null;
    let addressLine2 = null;
    let city = null;
    let county = null;
    let state = null;
    let country = null;
    let zip = null; 

    let result = {};
    result.errorCode = errorCodes.SUCCESS;
    dbConnection.createConnection((error, connection) => {
        if (error) 
        {
            result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
            logger.error(error.message);
            cb(error);
        }
        else 
        {
            let start_time = new Date();
            let insertQuery = "insert into master.patient_info (salutation, firstname, middlename, lastname, suffix, gender, birthDate, emailAddress, maritalStatus, bloodType,  addressLine1, addressLine2, city, county, state, country, zip, phoneNumbers, mrn) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)";
            logger.debug(insertQuery);
            connection.query(insertQuery, [salutation, firstName, middleName, lastName, suffix, gender, birthDate, emailAddres, maritalStatus, bloodType,  addressLine1, addressLine2, city, county, state, country, zip, phoneNumbers, mrn], (errInsert, resultSet) => {
                if (errInsert) 
                {
                    logger.info(" took: " + (new Date() - start_time) + "ms, for:" + insertQuery);
                    result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                    logger.error(errInsert.message);
                    dbConnection.closeConnection(connection);
                    cb(result, null);
                }
                else 
                {
                    logger.info(" took: " + (new Date() - start_time) + "ms, for:" + insertQuery);
                    result.errorCode = errorCodes.SUCCESS;
                    logger.debug("successfully inserted patient info");
                    dbConnection.closeConnection(connection);
                    cb(null, result);
                }
            });
        }
    });
};
 
//update patient info
sendHra.updatePatientInfo = (mrn, firstName, middleName, lastName, emailAddress, phoneNumbers, cb) => {
    let salutation = null;
    let suffix = null;
    let gender  = null;
    let birthDate = null;
    let maritalStatus = null;
    let bloodType = null;
    let addressLine1 = null;
    let addressLine2 = null;
    let city = null;
    let county = null;
    let state = null;
    let country = null;
    let zip = null; 
    
    let result = {};
    result.errorCode = errorCodes.SUCCESS;
    dbConnection.createConnection((error, connection) => {
        if (error) 
        {
            result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
            logger.error(error.message);
            cb(error);
        }
        else 
        {
            let start_time = new Date();
            let insertQuery = "UPDATE master.patient_info SET salutation = $1,firstname = $2,middlename = $3,lastname = $4,suffix = $5,gender = $6,birthDate = $7,emailAddress = $8, maritalStatus = $9,bloodType = $10, addressLine1 = $11, addressLine2 = $12, city = $13, county = $14, state = $15, country = $16, zip = $17, phoneNumbers = $18 WHERE mrn ='"+mrn+"'";
            logger.debug(insertQuery);
            connection.query(insertQuery, [salutation, firstName, middleName, lastName, suffix, gender, birthDate, emailAddress, maritalStatus, bloodType,  addressLine1, addressLine2, city, county, state, country, zip, phoneNumbers], (errInsert, resultSet) => {
                if (errInsert) 
                {
                    logger.info(" took: " + (new Date() - start_time) + "ms, for:" + insertQuery);
                    result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                    logger.error(errInsert.message);
                    dbConnection.closeConnection(connection);
                    cb(result, null);
                }
                else 
                {
                    logger.info(" took: " + (new Date() - start_time) + "ms, for:" + insertQuery);
                    result.errorCode = errorCodes.SUCCESS;
                    logger.debug("successfully inserted HRA status");
                    dbConnection.closeConnection(connection);
                    cb(null, result);
                }
            });
        }
    });
};

//insert message content into DB
sendHra.addMessageNotification = (messageObj, cb) => {

    let result = {};
    result.errorCode = errorCodes.SUCCESS;
    dbConnection.createConnection((error, connection) => {
        if (error) 
        {
            result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
            logger.error(error.message);
            cb(error);
        }
        else 
        {
            let start_time = new Date();
            let insertQuery = "insert into master.messagenotification (email_to, email_from, subject, cc, html_message, status, type) VALUES($1, $2, $3, $4, $5, $6, $7)";
            logger.debug(insertQuery);
            connection.query(insertQuery, messageObj, (errInsert, resultSet) => {
                if (errInsert) 
                {
                    logger.info(" took: " + (new Date() - start_time) + " for:" + insertQuery);
                    result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                    logger.error(errInsert.message);
                    dbConnection.closeConnection(connection);
                    cb(result, null);
                }
                else 
                {
                    logger.info(" took: " + (new Date() - start_time) + " for:" + insertQuery);
                    result.errorCode = errorCodes.SUCCESS;
                    logger.debug("successfully inserted notification message info");
                    dbConnection.closeConnection(connection);
                    cb(null, result);
                }
            });
        }
    });
};

sendHra.updateHraStatus = (orgId, patientId, assessmentId, patientAssessmentId, cb) => {
    let result = {};
    result.errorCode = errorCodes.SUCCESS;
    let hraStatus = "completed";
    
    dbConnection.createConnection((error, connection) => {
        if (error) 
        {
            result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
            logger.error(error.message);
            cb(error);
        }
        else 
        {
            let start_time = new Date();
            let selectQuery = `select * from master.hra_status 
                                where mrn = $1 and assessment_id = $2 and org_id = $3  and hra_status = 'pending' `;
            logger.debug(selectQuery);
            connection.query(selectQuery, [patientId, assessmentId, orgId], (error, resultSet) => {
                if (error) 
                {
                    logger.info(" took: " + (new Date() - start_time) + " for:" + selectQuery);
                    result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                    logger.error(error.message);
                    if(connection)
                        dbConnection.closeConnection(connection);
                    cb(result, null);
                }
                else if(resultSet.rows.length == 0)
                {
                    logger.info(" took: " + (new Date() - start_time) + " for:" + selectQuery);
                    result.errorCode = errorCodes.API_NOT_FOUND;
                    result.errorCode.hint = "Invalid parameter(s)/Already completed.";
                    logger.debug("patient is not available");
                    if(connection)
                        dbConnection.closeConnection(connection);
                    cb(result, null);
                }
                else
                {
                    let updateQuery = `update master.hra_status 
                                        set (hra_status, patientassessment_id, date_completed) = row ($1, $2, NOW()) 
                                        where mrn = $3  and assessment_id = $4 and org_id = $5 and hra_status = 'pending' 
                                        RETURNING hra_status, assessment_id, patientassessment_id `;
                    logger.debug(updateQuery);
                    connection.query(updateQuery, [hraStatus,  patientAssessmentId, patientId, assessmentId, orgId], (error, resultSet) => {
                        if (error) 
                        {
                            logger.info(" took: " + (new Date() - start_time) + " for:" + updateQuery);
                            result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                            logger.error(error.message);
                            if(connection)
                                dbConnection.closeConnection(connection);
                            cb(result, null);
                        }
                        else if(resultSet.rows.length == 0)
                        {
                            logger.info(" took: " + (new Date() - start_time) + " for:" + updateQuery);
                            result.errorCode = errorCodes.CONFLICT;
                            if(connection)
                                dbConnection.closeConnection(connection);
                            cb(result, null);
                        }
                        else
                        {
                            logger.info(" took: " + (new Date() - start_time) + " for:" + updateQuery);
                            result.errorCode  = errorCodes.SUCCESS;
                            result.hraStatus  = resultSet.rows[0].hra_status;
                            result.assessmentId = resultSet.rows[0].assessment_id;           
                            logger.debug("successfully updated hra status");
                            if(connection)
                                dbConnection.closeConnection(connection);
                            cb(null, result);
                        }
                    });

                }
            });
            
        }
    });

};

sendHra.surveyCompleted = (request, response) => {
    let result = {};

    let orgId               = request.body.org_id,
        pdf                 = request.files[0],
        patientId           = request.body.patient_id,
        assessmentId        = request.body.assessment_id,
        patientAssessmentId = request.body.patientAssessment_id,
        documentId          = uuid();

    if ( isValid(pdf) && pdf.mimetype != 'application/pdf')
    {
        result.errorCode      = errorCodes.UNAUTHORIZED;
        result.errorCode.hint = "unsupported file or content-type";
        logger.error("unsupported pdf or content-type for pdf.");
        utils.respondBack(request, response, result, null);
        return;
    }

    
    if( ! (isValid(assessmentId) && isValid(patientId) && isValid(patientAssessmentId) && isValid(orgId) ))
    {
        result.errorCode = errorCodes.UNAUTHORIZED;
        logger.error("org_id, assessment_id, patientAssessment_id or patient_id is undefined/null.");
        utils.respondBack(request, response, result, null);
        return;
    }    
    result.errorCode = errorCodes.SUCCESS;
    seq()
        .seq(function() {
            let self = this;
            sendHra.sendPdfToUpdox(orgId, patientId, assessmentId, patientAssessmentId, (error, success) => {
                if(error)
                {
                    result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                    logger.error(result.errorCode.message);
                    utils.respondBack(request, response, result, null);
                }
                else
                {
                    self();
                }
            }); 
        }).seq(function(){
            let self = this;
            sendHra.updateHraStatus(orgId, patientId, assessmentId, patientAssessmentId, (error, resultSet) => {
                if(error)
                {
                    result.errorCode = error.errorCode;
                    logger.error(result.errorCode.message);
                    utils.respondBack(request, response, result, null);
                }
                else
                {
                    result = {};
                    result.errorCode = errorCodes.SUCCESS;
                    result.hraStatus = resultSet.hraStatus;
                    result.assessmentId = resultSet.assessmentId;
                    self();
                }
            });
    }).seq(function(){
            let self = this;
            if( isValid(pdf) && ! isEmpty(pdf) )
            {
                sendHra.saveFile(patientId, patientAssessmentId, pdf.buffer, documentId, (error, path) => {
                    if (error) 
                    {
                        result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                        logger.error(error.message);
                        utils.respondBack(request, response, result, null);
                    }
                    else
                    {
                        logger.error(result.errorCode.message);
                        logger.info("hra status updated successfully.");
                        utils.respondBack(request, response, result, null);
                    }
                });
            }
            else
            {
                logger.error(result.errorCode.message);
                logger.info("hra status updated successfully.");
                utils.respondBack(request, response, result, null);
            }
            
        });
};


//to check if there is any pending assessment and if any get DateTime from DB
sendHra.getDateSubmitted = (patientId, assessmentId, orgId, cb) => {

    let result = {};
    result.errorCode = errorCodes.SUCCESS;

    dbConnection.createConnection((error, connection) => {
        if (error) 
        {
            result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
            logger.error(error.message);
            cb(error, null);
        }
        else 
        {
            let start_time = new Date();
            let selectQuery = "select * from master.hra_status where mrn = $1 ";            
            logger.debug(selectQuery);
            connection.query(selectQuery, [patientId], (error, resultSet) => {
                if (error) 
                {
                    logger.info(" took: " + (new Date() - start_time) + " for:" + selectQuery);
                    result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                    logger.error(error.message);
                    dbConnection.closeConnection(connection);
                    cb(result, null);
                }
                else if (resultSet.rows.length == 0)
                {
                    logger.info(" took: " + (new Date() - start_time) + " for:" + selectQuery);
                    result.errorCode = errorCodes.UNAUTHORIZED;
                    logger.error(result.errorCode.message);
                    dbConnection.closeConnection(connection);
                    cb(result, null);
                }
                else 
                {
                    let start_time = new Date();
                    let selectQuery = "select * from master.hra_status where mrn = $1 and assessment_id = $2 and org_id = $3 and hra_status = 'pending' ";  
                    logger.debug(selectQuery);

                    connection.query(selectQuery, [patientId, assessmentId, orgId], (error, resultSet) => {
                        if (error) 
                        {
                            logger.info(" took: " + (new Date() - start_time) + " for:" + selectQuery);
                            result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                            logger.error(error.message);
                            dbConnection.closeConnection(connection);
                            cb(result, null);
                        }
                        else if (resultSet.rows.length == 1)
                        {
                            logger.info(" took: " + (new Date() - start_time) + " for:" + selectQuery);
                            dbConnection.closeConnection(connection);
                            cb(null, resultSet.rows[0].date_submitted);
                        }
                        else 
                        {
                            logger.info(" took: " + (new Date() - start_time) + " for:" + selectQuery);
                            result.errorCode = errorCodes.CONFLICT;
                            logger.error(result.errorCode.message);
                            dbConnection.closeConnection(connection);
                            cb(result, null);
                        }
                    });
                }
            });
        }
    });

};

sendHra.sendPdfToUpdox = (orgId, patientId, assessmentId, patientAssessmentId, cb) => {
    let result = {};
    result.errorCode = errorCodes.SUCCESS;

    let hraStatus = "completed";
    let status    = "pending";
    let type      = "file"; 

    dbConnection.createConnection((error, connection) => {
        if (error) 
        {
            result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
            logger.error(error.message);
            cb(error, null);
        }
        else 
        {
            let start_time = new Date();
            let insertQuery = "insert into master.sendtoupdox (org_id, patient_id, hra_status, status, type, assessment_id) VALUES($1, $2, $3, $4, $5, $6)";
            logger.debug(insertQuery);
            connection.query(insertQuery, [orgId, patientId, hraStatus, status, type, assessmentId], (errInsert, resultSet) => {
                
                if (errInsert) 
                {
                    logger.info(" took: " + (new Date() - start_time) + " for:" + insertQuery);
                    result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                    logger.error(errInsert.message);
                    dbConnection.closeConnection(connection);
                    cb(result, null);
                }
                else 
                {
                    logger.info(" took: " + (new Date() - start_time) + " for:" + insertQuery);
                    logger.debug("successfully inserted pdf file data info");
                    dbConnection.closeConnection(connection);
                    cb(null, result);
                }
            });
        }
    });
};


//on focus out
sendHra.checkHraStatus = (request, response) => {
    let result = {};
    result.errorCode  = errorCodes.SUCCESS;
    let mrnNo         = request.params.mrnNo;
    let Assessments   = [];
    // let allHraStatus  = [];

    dbConnection.createConnection((error, connection) => {
        if (error) 
        {
            result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
            logger.error(error.message);
            utils.respondBack(request, response, result, connection);
        }
        else 
        {
            let start_time = new Date();
            let selectQuery = "select * from master.hra_status where mrn = $1 ";
            logger.debug(selectQuery);
            connection.query(selectQuery, [mrnNo], (error, resultSet) => {
                if (error) 
                {
                    logger.info(" took: " + (new Date() - start_time) + "ms, for:" + selectQuery);
                    result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                    logger.error(error.message);
                    dbConnection.closeConnection(connection);
                    utils.respondBack(request, response, result, connection);
                    
                }
                else if(resultSet.rows.length == 0) 
                {
                    result.patient_avail = "NEW_PATIENT";
                    logger.info(" took: " + (new Date() - start_time) + "ms, for:" + selectQuery);
                    dbConnection.closeConnection(connection);
                    utils.respondBack(request, response, result, connection);
                }
                else 
                {   
                    for (let i in resultSet.rows) 
                    {
                        let assessObj                = {};
                        assessObj                    = resultSet.rows[i].assessment;
                        assessObj.physicianId        = resultSet.rows[i].physician;
                        assessObj.org_id             = resultSet.rows[i].org_id;
                        assessObj.patientAssessmentId = resultSet.rows[i].patientassessment_id;

                        if ( resultSet.rows[i].hra_status == "completed")
                        {
                            assessObj.completed = resultSet.rows[i].date_submitted;
                        }
                        else if ( resultSet.rows[i].hra_status == "pending")
                        {
                            assessObj.pending = resultSet.rows[i].date_submitted;
                        }
                        Assessments.push(assessObj);
                    }
                    result.Assessments         = Assessments;
                    result.patientName         = resultSet.rows[0].patient_name;
                    result.preferredChannel    = resultSet.rows[0].type;
                    result.emailId             = resultSet.rows[0].email;
                    result.mobile              = resultSet.rows[0].phone;
                    result.physicianId         = resultSet.rows[0].physician; 
                    
                    logger.info(" took: " + (new Date() - start_time) + "ms, for:" + selectQuery);
                    dbConnection.closeConnection(connection);
                    utils.respondBack(request, response, result, connection);
                }
            });
        }
    });
};

//to view pdf for view
sendHra.viewPdf = (request, response) =>{

    let result = {};
    result.errorCode = errorCodes.SUCCESS;

    let mrnNo               = request.params.mrn,
        patientAssessmentId = request.params.patientAssessmentId;

    if( ! ( isValid(mrnNo) &&  isValid(patientAssessmentId)) )
    {
        result.errorCode = errorCodes.UNAUTHORIZED;
        logger.error("some data are undefined.");
        utils.respondBack(request, response, result, null);
        return;
    }
    else
    {
        sendHra.getPdfFile(mrnNo, patientAssessmentId, result, (error, resultSet) => {
            if (error) 
            {
                result.errorCode = error.errorCode;
                logger.error(error.errorCode.message);
                utils.respondBack(request, response, result, null);        
            }
            else 
            {
                result.errorCode = errorCodes.SUCCESS;
                result.pdfFile = resultSet.pdfFile;
                utils.respondBack(request, response, result, null);        
            }
        });
    }
};

//fetch pdf from DB or HA
sendHra.getPdfFile = (mrnNo, patientAssessmentId, result, cb) =>{
 
    seq()
    .seq(function() {
        let self = this;
        dbConnection.createConnection((error, connection) => {
            if (error) 
            {
                result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                logger.error(error.message);
                cb(error, null);
            }
            else 
            {
                let start_time = new Date();
                let selectQuery = "select pdf_file from master.hra_status where mrn = $1 and patientassessment_id = $2";
                logger.debug(selectQuery);
                connection.query(selectQuery, [mrnNo, patientAssessmentId], (error, resultSet) => {
                    if (error) 
                    {
                        logger.info(" took: " + (new Date() - start_time) + " for:" + selectQuery);
                        result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                        logger.error(error.message);
                        dbConnection.closeConnection(connection);
                        cb(result, null);
                    }
                    else if (resultSet.rows.length != 1) 
                    {
                        logger.info(" took: " + (new Date() - start_time) + " for:" + selectQuery);
                        result.errorCode = errorCodes.API_NOT_FOUND;
                        logger.debug(result.errorCode.message);
                        dbConnection.closeConnection(connection);
                        cb(result, null);
                    }
                    else if (resultSet.rows[0].pdf_file)
                    {
                        logger.info(" took: " + (new Date() - start_time) + " for:" + selectQuery);
                        logger.debug("successfully fetched pdf file from DB");
                        dbConnection.closeConnection(connection);
                        result.pdfFile = resultSet.rows[0].pdf_file;
                        cb(null, result);
                    } 
                    else 
                    {
                        dbConnection.closeConnection(connection);
                        self(); // call next seq to get pdf from HA
                    }
                });
            }
        });
    }).seq(function(){
        let self = this;
        let url  = hraUrl.Url + `/patient/${mrnNo}/assessment/${patientAssessmentId}/report/pdf`;
        healthAware.callApi('GET', url, {}, result, (error, body) => {
            if (error) 
            {
                cb(error, null);
            }
            else if (isEmpty(body))
            {
                result.errorCode = errorCodes.API_NOT_FOUND;
                logger.error("pdf file does not exist for "+patientAssessmentId+" at HA");
                cb(result, null);
            }
            else
            {
                sendHra.saveFile(mrn, patientAssessmentId, body, null, (error, path) => {
                    if (error) 
                    {
                        result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                        logger.error(error.message);
                        cb(result, null);
                    }
                    else
                    {
                        result.pdfFile = path;
                        cb(null, result);
                    }
                });
            }
        });
    });
};

//save pdf file into temp folder AND sending "PDF to REDOX"
sendHra.saveFile = (mrn, patientAssessmentId, pdf, docId, cb) => {
    let result = {};
    result.errorCode = errorCodes.SUCCESS;
    let directory  = process.cwd()+`/server/temp`;
    let pdfFile    = `report_${patientAssessmentId}.pdf`;
    let path       = directory + "/" + pdfFile;
    
    seq()
    .seq(function(){
        let self = this;
        mkdirp(directory, function(error) { 
            if (error)
            {
                result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                logger.error(error);
                cb(error, null);
            }
            else
            {
                fs.writeFile(path, pdf,(err)=>{
                    if(err){
                        result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                        logger.error(error);
                        cb(error, null);
                    }else{
                        logger.debug("got pdf file and saved in "+directory);
                        self();
                        // cb(null, errorCodes.SUCCESS);  //need to remove later
                    }
                });
            }
          });
    }).seq(function(){
        let self = this;
        dbConnection.createConnection((error, connection) => {
            if (error) 
            {
                result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                logger.error(error.message);
                cb(error, null);
            }
            else 
            {
                let start_time = new Date();
                let selectQuery = `update master.hra_status 
                                    set pdf_file = $1, pdf_doc_id = $2
                                    where patientassessment_id = $3`;
                logger.debug(selectQuery);
                connection.query(selectQuery, [pdfFile, docId, patientAssessmentId], (error, resultSet) => {
                    if (error) 
                    {
                        logger.info(" took: " + (new Date() - start_time) + " for:" + selectQuery);
                        result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                        logger.error(error.message);
                        dbConnection.closeConnection(connection);
                        cb(result, null);
                    }
                    else
                    {
                        logger.info(" took: " + (new Date() - start_time) + " for:" + selectQuery);
                        dbConnection.closeConnection(connection);
                        self();
                    }
            
                });
            }
        });
    })
    .seq(function(){
        let self = this;

        redox.sendPdfToRedox(mrn, patientAssessmentId, docId, path, (err, status)=>{   //sending "PDF to REDOX"
            if(err) 
                logger.error("Could not be sent pdf to Redox.");
            else 
                logger.info("PDF sent to redox successfully.")
        })
        
        cb(null, pdfFile);
    });
};

// to resend HRA form 
sendHra.resendHraProcess = (mrnNo,assessmentId, dateSubmitted, orgId, cb) => {
    
    let result = {};

    dateSubmitted = addZeroToMillisecond(dateSubmitted, 3);
    
    dbConnection.createConnection((error, connection) => {
        if (error) 
        {
            result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
            logger.error(error.message);
            cb(result,null);
        }
        else 
        {
            let start_time = new Date();
            let updateQuery = "update master.hra_status set date_submitted = $1  where mrn = $2 and assessment_id = $3 and org_id = $4 and hra_status = 'pending'";
            logger.debug(updateQuery);
            connection.query(updateQuery, [dateSubmitted, mrnNo, assessmentId, orgId], (error, resultSet) => {
                if (error) 
                {
                    logger.info(" took: " + (new Date() - start_time) + "ms, for:" + updateQuery);
                    result.errorCode = errorCodes.INTERNAL_SERVER_ERROR;
                    logger.error(error.message);
                    dbConnection.closeConnection(connection);
                    cb(result, null);
                }
                else 
                {
                    logger.info(" took: " + (new Date() - start_time) + "ms, for:" + updateQuery);
                    result.errorCode = errorCodes.success;
                    logger.info("hra_status date has been updated");
                    dbConnection.closeConnection(connection);
                    cb(null, result);

                }
            });
        }
    });
};



export default sendHra;