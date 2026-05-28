const admin = require('firebase-admin');
const xlsx = require('xlsx');
const nodemailer = require('nodemailer');
require('dotenv').config();

// Timezone Helper: Convert UTC runner time to Chicago (CST/CDT) time context
const chicagoTimeStr = new Date().toLocaleString("en-US", { timeZone: "America/Chicago" });
const chicagoDate = new Date(chicagoTimeStr);

// Find tomorrow's date in Chicago time
const tomorrowDate = new Date(chicagoDate);
tomorrowDate.setDate(chicagoDate.getDate() + 1);

// If tomorrow's month is different from today's, then today is the last day of the month.
const isLastDayOfTheMonth = tomorrowDate.getMonth() !== chicagoDate.getMonth();

if (!isLastDayOfTheMonth) {
    console.log(`[EquipTrack Backup] Localized date is ${chicagoDate.toDateString()}. Not the last day of the month. Slept.`);
    process.exit(0);
}

console.log(`[EquipTrack Backup] Last day of the month reached: ${chicagoDate.toDateString()}. Starting backup...`);

const runBackup = async () => {
    try {
        if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
            throw new Error("Missing FIREBASE_SERVICE_ACCOUNT environment variable.");
        }

        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });

        const db = admin.firestore();

        const [inventorySnap, employeesSnap, checkoutsSnap] = await Promise.all([
            db.collection('inventory').get(),
            db.collection('employees').get(),
            db.collection('checkouts').get()
        ]);

        const inventory = inventorySnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        const employees = employeesSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        const checkouts = checkoutsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        // 1. Process Inventory with current borrower assignments
        const processedInventory = inventory.map(item => {
            const activeLoan = checkouts.find(c => c.itemId === item.id && c.status === 'active');
            let borrower = 'In Storage';
            if (activeLoan) {
                const emp = employees.find(e => e.id === activeLoan.employeeId);
                borrower = activeLoan.empName || (emp ? emp.name : 'Unknown Staff');
            }
            return {
                "Model Name": item.name || '',
                "Category": item.category || '',
                "Laptop ID (LN)": item.lnNumber || 'N/A',
                "Serial Number (SN)": item.serial || 'N/A',
                "Status": item.status === 'checked-out' ? 'On Loan' : 'Available',
                "Current Borrower": borrower,
                "Database ID": item.id
            };
        });

        // 2. Process Employees
        const processedEmployees = employees.map(emp => ({
            "Employee ID": emp.id,
            "Name": emp.name || '',
            "Department": emp.department || 'General'
        }));

        // 3. Process Checkout History logs
        const processedCheckouts = checkouts.map(loan => {
            const item = inventory.find(i => i.id === loan.itemId);
            const borrowerName = loan.empName || employees.find(e => e.id === loan.employeeId)?.name || 'Former Staff';
            return {
                "Borrower": borrowerName,
                "Item Model": item ? item.name : 'Deleted Asset',
                "Laptop ID": item ? (item.lnNumber || 'N/A') : 'N/A',
                "Serial Number": item ? (item.serial || 'N/A') : 'N/A',
                "Checkout Date": loan.checkoutDate || '',
                "Status": loan.status || '',
                "Return Date": loan.returnDate || 'N/A',
                "Return Condition": loan.returnCondition || 'N/A',
                "Return Notes": loan.returnNotes || 'N/A'
            };
        });

        const wb = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(processedInventory), "Inventory");
        xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(processedEmployees), "Employees");
        xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(processedCheckouts), "Checkout History");

        const excelBuffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
        const dateStamp = chicagoDate.toISOString().split('T')[0];
        const fileName = `EquipTrack_Backup_${dateStamp}.xlsx`;

        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || '587'),
            secure: process.env.SMTP_PORT === '465',
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });

        const mailOptions = {
            from: `"EquipTrack Backups" <${process.env.SMTP_USER}>`,
            to: process.env.TO_EMAIL,
            subject: `📊 EquipTrack Monthly Backup - ${chicagoDate.toLocaleString('default', { month: 'long', year: 'numeric' })}`,
            text: `Hi,\n\nPlease find attached the scheduled database export from EquipTrack for the end of ${chicagoDate.toLocaleString('default', { month: 'long' })}.\n\nDate of Export: ${chicagoDate.toDateString()}\nTotal assets registered: ${inventory.length}\nActive assignments: ${activesCount(checkouts)}\n\nBest regards,\nEquipTrack Automations Engine`,
            attachments: [
                {
                    filename: fileName,
                    content: excelBuffer
                }
            ]
        };

        await transporter.sendMail(mailOptions);
        console.log(`[EquipTrack Backup] Monthly database backup successfully sent to: ${process.env.TO_EMAIL}`);
        process.exit(0);
    } catch (err) {
        console.error("[EquipTrack Backup] Process aborted due to error:", err);
        process.exit(1);
    }
};

const activesCount = (checkouts) => {
    return checkouts.filter(c => c.status === 'active').length;
};

runBackup();
